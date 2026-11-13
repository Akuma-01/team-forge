import { setTimeout as delay } from 'node:timers/promises';
import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { busyError, logDatabaseError, mapPgError, pgDiagnostic } from './errors.js';
import { guardClient } from './client.js';

export type Tx = {
  q: <Row extends QueryResultRow = QueryResultRow>(sql: string, params?: unknown[]) => Promise<QueryResult<Row>>;
  afterCommit: (hook: () => void | Promise<void>) => void;
};

export type TxOptions = {
  // Injectable backoff and diagnostic sink allow deterministic retry tests.
  backoff?: (attempt: number) => Promise<void>;
  report?: (event: string, error: unknown) => void;
};

const retryable = new Set(['40P01', '40001']);

export async function withTx<T>(pool: Pool, work: (tx: Tx) => Promise<T>, options: TxOptions = {}): Promise<T> {
  const report = (event: string, error: unknown) => {
    // Observability must never change a transaction's outcome.
    try { (options.report ?? logDatabaseError)(event, error); } catch { /* diagnostic sink failed */ }
  };
  for (let attempt = 1; attempt <= 3; attempt++) {
    let client: PoolClient;
    try { client = await pool.connect(); } catch (error) {
      report('database.acquire.failed', error);
      throw busyError();
    }
    const hooks: Array<() => void | Promise<void>> = [];
    const guard = guardClient(client);
    let result!: T;
    let failure: unknown;
    let failed = false;
    let discard = false;
    let active = true;
    let queryFailed = false;
    let queryFailure: unknown;
    try {
      await client.query(`BEGIN ISOLATION LEVEL READ COMMITTED;
        SELECT set_config('lock_timeout', '2s', true),
               set_config('statement_timeout', '5s', true),
               set_config('idle_in_transaction_session_timeout', '10s', true)`);
      result = await work({
        q: async <Row extends QueryResultRow>(sql: string, params?: unknown[]) => {
          if (!active) throw new Error('Transaction is no longer active.');
          try { return await client.query<Row>(sql, params); } catch (error) {
            queryFailed = true;
            queryFailure = error;
            throw error; // Preserve SQLSTATE until the retry decision.
          }
        },
        afterCommit: (hook) => {
          if (!active) throw new Error('Transaction is no longer active.');
          hooks.push(hook);
        },
      });
      // A caught SQL failure still aborts this attempt; COMMIT on an aborted PG transaction
      // can return a ROLLBACK command tag instead of throwing.
      if (queryFailed) throw queryFailure;
      guard.assertHealthy();
      const commit = await client.query('COMMIT');
      if (commit.command !== 'COMMIT') throw new Error('Transaction did not commit.');
    } catch (error) {
      failed = true;
      failure = error;
      try { await client.query('ROLLBACK'); } catch { discard = true; }
    } finally {
      active = false;
      guard.release(discard); // Before backoff, error handling or any publication.
    }
    if (failed) {
      if (retryable.has(pgDiagnostic(failure).code ?? '') && attempt < 3) {
        await (options.backoff ?? (() => delay(10 + Math.random() * 40)))(attempt);
        continue;
      }
      const mapped = mapPgError(failure);
      if (mapped.status === 500) report('database.transaction.failed', failure);
      throw mapped;
    }
    for (const hook of hooks) {
      try { await hook(); } catch (error) { report('database.after_commit.failed', error); }
    }
    return result;
  }
  throw busyError();
}
