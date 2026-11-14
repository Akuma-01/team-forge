import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { AppError, busyError, logDatabaseError } from './errors.js';
import { withTx } from './tx.js';
import type { Tx } from './tx.js';
import { validate } from '../middleware/validate.js';

export type Result<T> = { status: number; body: T };
export type Intent = { userId: string; method: string; path: string; body: unknown; key?: string | undefined };

// Canonicalize object keys recursively; array order and JSON values remain significant.
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(',')}}`;
  throw new Error('Expected a JSON request body.');
}
export function fingerprint(intent: Pick<Intent, 'method' | 'path' | 'body'>) {
  return createHash('sha256').update(`${intent.method.toUpperCase()}\n${intent.path}\n${canonicalJson(intent.body)}`).digest('hex');
}

export async function withIdempotentTx<T>(pool: Pool, intent: Intent, work: (tx: Tx) => Promise<Result<T>>): Promise<Result<T> & { replay: boolean }> {
  const key = intent.key === undefined ? undefined : validate(z.string().uuid(), intent.key).toLowerCase();
  const hash = fingerprint(intent);
  return withTx(pool, async (tx) => {
    if (key) {
      let acquired = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        const inserted = await tx.q(`INSERT INTO idempotency_keys (user_id, key, request_hash) VALUES ($1, $2, $3)
          ON CONFLICT (user_id, key) DO NOTHING RETURNING key`, [intent.userId, key, hash]);
        if (inserted.rowCount === 1) { acquired = true; break; }
        const { rows: [previous] } = await tx.q<{ request_hash: string; response_status: number | null; response_body: T }>(
          `SELECT request_hash, response_status, response_body FROM idempotency_keys
           WHERE user_id = $1 AND key = $2 FOR SHARE`, [intent.userId, key]);
        if (!previous) continue; // A retention sweep deleted it between INSERT and SELECT.
        if (previous.request_hash !== hash) throw new AppError('IDEMPOTENCY_KEY_REUSED', 422, 'This request key was already used for a different action.');
        if (previous.response_status === null || previous.response_status < 200 || previous.response_status >= 300) {
          throw new AppError('INTERNAL', 500, 'An unexpected error occurred.');
        }
        return { status: previous.response_status, body: previous.response_body, replay: true };
      }
      if (!acquired) throw busyError();
    }
    const result = await work(tx);
    if (result.status < 200 || result.status >= 300) throw new Error('Domain failures must throw and roll back.');
    if (key) await tx.q(`UPDATE idempotency_keys SET response_status = $3, response_body = $4::jsonb,
      created_at = clock_timestamp() WHERE user_id = $1 AND key = $2`,
    [intent.userId, key, result.status, JSON.stringify(result.body)]);
    return { ...result, replay: false };
  });
}

// Called only after authentication and strict route/body validation. HTTP success
// is sent after withTx has passed deferred constraints and committed.
export async function domainMutation<T>(pool: Pool, req: Request, res: Response, work: (tx: Tx) => Promise<Result<T>>) {
  const result = await withIdempotentTx(pool, {
    userId: String(res.locals.userId), key: req.get('Idempotency-Key'),
    method: req.method, path: req.baseUrl + req.path, body: req.body ?? {},
  }, work);
  if (result.replay) res.setHeader('Idempotent-Replay', 'true');
  res.status(result.status).json(result.body);
}

export async function cleanupIdempotency(pool: Pool) {
  return withTx(pool, async (tx) => {
    const result = await tx.q(`WITH expired AS (
      SELECT user_id, key FROM idempotency_keys
      WHERE created_at < clock_timestamp() - interval '24 hours' AND response_status BETWEEN 200 AND 299
      ORDER BY created_at, user_id, key LIMIT 500 FOR UPDATE SKIP LOCKED
    ) DELETE FROM idempotency_keys k USING expired e WHERE k.user_id = e.user_id AND k.key = e.key`);
    return result.rowCount ?? 0;
  });
}

export function startIdempotencyCleanup(pool: Pool) {
  let pending: Promise<unknown> | undefined;
  const timer = setInterval(() => {
    if (pending) return;
    pending = cleanupIdempotency(pool).catch((error: unknown) => logDatabaseError('idempotency.cleanup.failed', error))
      .finally(() => { pending = undefined; });
  }, 60 * 60_000);
  timer.unref();
  return async () => { clearInterval(timer); await pending; };
}
