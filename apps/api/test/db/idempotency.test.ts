import { randomUUID } from 'node:crypto';
import type { Pool, QueryResult } from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { canonicalJson, cleanupIdempotency, fingerprint, withIdempotentTx } from '../../src/db/idempotency.js';
import { AppError } from '../../src/db/errors.js';
import { testDatabase } from '../helpers/database.js';
import { createParticipants } from '../helpers/factories.js';
import { bounded, signal } from '../helpers/signals.js';

let db: Awaited<ReturnType<typeof testDatabase>>;
let userId: string;
beforeEach(async () => { db = await testDatabase(); userId = (await createParticipants(db.pool, 1)).users[0]!; });
afterEach(async () => { await db.dispose(); });
const intent = (key = randomUUID()) => ({ key, userId, method: 'PATCH', path: '/api/me', body: { displayName: 'After' } });

describe('transactional idempotency and retention', () => {
  it('canonicalizes recursively without dropping special keys, preserving array order and separating methods/paths', () => {
    expect(canonicalJson({ z: [{ b: 2, a: 1 }], a: null })).toBe(canonicalJson({ a: null, z: [{ a: 1, b: 2 }] }));
    expect(canonicalJson(JSON.parse('{"__proto__":{"a":1},"constructor":2}'))).toContain('"__proto__"');
    const base = intent();
    expect(fingerprint(base)).not.toBe(fingerprint({ ...base, method: 'POST' }));
    expect(fingerprint(base)).not.toBe(fingerprint({ ...base, path: '/api/elsewhere' }));
    expect(fingerprint({ ...base, body: [1, 2] })).not.toBe(fingerprint({ ...base, body: [2, 1] }));
  });

  it('does not retain a failed effect, and captures response state before commit for later replay', async () => {
    const request = intent();
    await expect(withIdempotentTx(db.pool, request, async (tx) => {
      await tx.q("UPDATE users SET display_name='Rolled back' WHERE id=$1", [userId]);
      throw new AppError('TEAM_FULL', 409, 'Full');
    })).rejects.toMatchObject({ code: 'TEAM_FULL' });
    expect((await db.pool.query('SELECT * FROM idempotency_keys')).rowCount).toBe(0);
    expect((await db.pool.query('SELECT display_name FROM users WHERE id=$1', [userId])).rows[0]?.display_name).toBe('Test participant');
    const out = await withIdempotentTx(db.pool, request, async (tx) => {
      await tx.q("UPDATE users SET display_name='After' WHERE id=$1", [userId]);
      return { status: 200, body: { displayName: 'After' } };
    });
    await db.pool.query("UPDATE users SET display_name='Later' WHERE id=$1", [userId]);
    const replay = await withIdempotentTx(db.pool, request, async () => { throw new Error('Replay must not execute work.'); });
    expect(replay).toEqual({ ...out, replay: true });
  });

  it('refuses unsuccessful handler results and incomplete committed key rows', async () => {
    const request = intent();
    await expect(withIdempotentTx(db.pool, request, async () => ({ status: 409, body: {} }))).rejects.toMatchObject({ status: 500 });
    expect((await db.pool.query('SELECT * FROM idempotency_keys')).rowCount).toBe(0);
    await db.pool.query('INSERT INTO idempotency_keys (user_id,key,request_hash) VALUES ($1,$2,$3)', [userId, request.key, fingerprint(request)]);
    await expect(withIdempotentTx(db.pool, request, async () => ({ status: 200, body: {} }))).rejects.toMatchObject({ status: 500 });
  });

  it('bounds each cleanup to 500, skips locked/incomplete/recent rows and permits reuse after retention deletion', async () => {
    await db.pool.query(`INSERT INTO idempotency_keys (user_id,key,request_hash,response_status,response_body,created_at)
      SELECT $1, gen_random_uuid()::text, 'old', 200, '{}'::jsonb, clock_timestamp()-interval '25 hours' FROM generate_series(1,503)`, [userId]);
    const fresh = intent();
    await withIdempotentTx(db.pool, fresh, async () => ({ status: 200, body: { kept: true } }));
    await db.pool.query("UPDATE idempotency_keys SET created_at=clock_timestamp()-interval '23 hours' WHERE key=$1", [fresh.key]);
    await db.pool.query("INSERT INTO idempotency_keys (user_id,key,request_hash,created_at) VALUES ($1,$2,'incomplete',clock_timestamp()-interval '25 hours')", [userId, randomUUID()]);
    const blocker = await db.pool.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query("SELECT key FROM idempotency_keys WHERE request_hash='old' LIMIT 1 FOR UPDATE");
      expect(await cleanupIdempotency(db.pool)).toBe(500);
      expect(await cleanupIdempotency(db.pool)).toBe(2);
    } finally { await blocker.query('ROLLBACK'); blocker.release(); }
    expect(await cleanupIdempotency(db.pool)).toBe(1);
    expect((await db.pool.query('SELECT * FROM idempotency_keys')).rowCount).toBe(2);
    expect((await withIdempotentTx(db.pool, fresh, async () => { throw new Error('Must replay within retention.'); })).body).toEqual({ kept: true });
    await db.pool.query("UPDATE idempotency_keys SET created_at=clock_timestamp()-interval '25 hours' WHERE key=$1", [fresh.key]);
    expect(await cleanupIdempotency(db.pool)).toBe(1);
    expect((await withIdempotentTx(db.pool, fresh, async () => ({ status: 200, body: { newEffect: true } }))).replay).toBe(false);
  });

  it('reacquires when cleanup wins between the conflicting INSERT and following SELECT', async () => {
    const request = intent();
    await withIdempotentTx(db.pool, request, async () => ({ status: 200, body: { first: true } }));
    await db.pool.query("UPDATE idempotency_keys SET created_at=clock_timestamp()-interval '25 hours' WHERE key=$1", [request.key]);
    const conflict = signal(); const resume = signal();
    // Pause a real pg connection after its INSERT returns the real conflict result.
    // No SQL result is mocked, and no production barrier/config flag is needed.
    const intercepted = { connect: async () => {
      const client = await db.pool.connect();
      const originalQuery = client.query;
      const originalRelease = client.release.bind(client);
      const query = originalQuery.bind(client) as (sql: string, params?: unknown[]) => Promise<QueryResult>;
      client.query = (async (sql: string, params?: unknown[]) => {
        const result = await query(sql, params);
        if (sql.startsWith('INSERT INTO idempotency_keys') && result.rowCount === 0) { conflict.resolve(); await bounded(resume.promise); }
        return result;
      }) as typeof client.query;
      client.release = (error?: Error | boolean) => { client.query = originalQuery; originalRelease(error); };
      return client;
    } } as unknown as Pool;
    const result = withIdempotentTx(intercepted, request, async () => ({ status: 200, body: { acquiredAfterCleanup: true } }));
    try { await bounded(conflict.promise); expect(await cleanupIdempotency(db.pool)).toBe(1); }
    finally { resume.resolve(); }
    expect(await result).toEqual({ status: 200, body: { acquiredAfterCleanup: true }, replay: false });
    expect((await db.pool.query('SELECT * FROM idempotency_keys WHERE key=$1', [request.key])).rowCount).toBe(1);
  });
});
