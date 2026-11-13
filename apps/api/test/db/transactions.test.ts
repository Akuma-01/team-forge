import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testDatabase } from '../helpers/database.js';
import { createParticipants } from '../helpers/factories.js';
import { bounded, signal } from '../helpers/signals.js';
import { withTx } from '../../src/db/tx.js';
import { AppError } from '../../src/db/errors.js';
import { assertInvariants } from '../../src/db/invariants.js';

let db: Awaited<ReturnType<typeof testDatabase>>;
beforeAll(async () => { db = await testDatabase(); });
afterAll(async () => { await db?.dispose(); });

describe('transaction runner against PostgreSQL', () => {
  it('uses one connection and transaction-local timeouts, restoring settings on release', async () => {
    const pool = new pg.Pool({ ...db.pool.options, max: 1 });
    try {
      const before = (await pool.query('SHOW lock_timeout')).rows[0];
      await withTx(pool, async (tx) => {
        const first = (await tx.q('SELECT pg_backend_pid() AS pid')).rows[0];
        const second = (await tx.q(`SELECT pg_backend_pid() AS pid,
          current_setting('transaction_isolation') AS isolation,
          current_setting('lock_timeout') AS lock_timeout,
          current_setting('statement_timeout') AS statement_timeout,
          current_setting('idle_in_transaction_session_timeout') AS idle_timeout`)).rows[0];
        expect(second).toEqual({ pid: first!.pid, isolation: 'read committed', lock_timeout: '2s', statement_timeout: '5s', idle_timeout: '10s' });
      });
      expect((await pool.query('SHOW lock_timeout')).rows[0]).toEqual(before);
    } finally { await pool.end(); }
  });

  it('rolls back all work and discards hooks on domain failure', async () => {
    const { hackathonId } = await createParticipants(db.pool, 1);
    let published = false;
    const error = new AppError('FORBIDDEN', 403, 'Forbidden.');
    await expect(withTx(db.pool, async (tx) => {
      await tx.q("INSERT INTO audit_log (hackathon_id, action) VALUES ($1, 'transaction.probe')", [hackathonId]);
      tx.afterCommit(() => { published = true; });
      throw error;
    })).rejects.toBe(error);
    expect((await db.pool.query('SELECT 1 FROM audit_log WHERE hackathon_id = $1', [hackathonId])).rowCount).toBe(0);
    expect(published).toBe(false);
    await assertInvariants(db.pool, hackathonId);
  });

  it('does not report success when a callback swallows a PostgreSQL error', async () => {
    let published = false;
    const diagnostics: unknown[] = [];
    await expect(withTx(db.pool, async (tx) => {
      try { await tx.q('SELECT 1 / 0'); } catch { /* Deliberately buggy callback. */ }
      tx.afterCommit(() => { published = true; });
      return 'incorrect-success';
    }, { report: (_event, error) => diagnostics.push(error) })).rejects.toMatchObject({ code: 'INTERNAL' });
    expect(diagnostics).toEqual([expect.objectContaining({ code: '22012' })]);
    expect(published).toBe(false);
  });

  it('releases before hooks, awaits async hooks, and ignores publication failure after COMMIT', async () => {
    const pool = new pg.Pool({ ...db.pool.options, max: 1, connectionTimeoutMillis: 200 });
    const { hackathonId } = await createParticipants(pool, 1);
    let observed = 0;
    const reports: string[] = [];
    try {
      const value = await withTx(pool, async (tx) => {
        await tx.q("INSERT INTO audit_log (hackathon_id, action) VALUES ($1, 'transaction.probe')", [hackathonId]);
        tx.afterCommit(async () => {
          observed = (await pool.query('SELECT 1 FROM audit_log WHERE hackathon_id = $1', [hackathonId])).rowCount!;
        });
        tx.afterCommit(async () => { throw new Error('Simulated publisher failure'); });
        tx.afterCommit(() => { observed += 1; });
        return 'committed';
      }, { report: (event) => reports.push(event) });
      expect(value).toBe('committed');
      expect(observed).toBe(2);
      expect(reports).toEqual(['database.after_commit.failed']);
      expect((await pool.query('SELECT 1 FROM audit_log WHERE hackathon_id = $1', [hackathonId])).rowCount).toBe(1);
      await assertInvariants(pool, hackathonId);
    } finally { await pool.end(); }
  });

  it('retries PostgreSQL serialization failures after releasing, retaining only the successful hooks and audit', async () => {
    const pool = new pg.Pool({ ...db.pool.options, max: 1, connectionTimeoutMillis: 200 });
    const { hackathonId } = await createParticipants(pool, 1);
    let attempts = 0;
    let backoffs = 0;
    let published = 0;
    try {
      await withTx(pool, async (tx) => {
        attempts += 1;
        await tx.q("INSERT INTO audit_log (hackathon_id, action) VALUES ($1, 'transaction.probe')", [hackathonId]);
        tx.afterCommit(() => { published += 1; });
        if (attempts < 3) await tx.q("DO $$ BEGIN RAISE EXCEPTION 'retry test' USING ERRCODE = '40001'; END $$");
      }, { backoff: async () => {
        backoffs += 1;
        // A second acquisition would time out if the failed attempt still held the only client.
        await pool.query('SELECT 1');
      } });
      expect({ attempts, backoffs, published }).toEqual({ attempts: 3, backoffs: 2, published: 1 });
      expect((await pool.query('SELECT 1 FROM audit_log WHERE hackathon_id = $1', [hackathonId])).rowCount).toBe(1);
      expect(pool.waitingCount).toBe(0);
      await assertInvariants(pool, hackathonId);
    } finally { await pool.end(); }
  });

  it('stops after three attempts and returns retryable BUSY', async () => {
    let attempts = 0;
    await expect(withTx(db.pool, async (tx) => {
      attempts += 1;
      await tx.q("DO $$ BEGIN RAISE EXCEPTION 'retry test' USING ERRCODE = '40001'; END $$");
    }, { backoff: async () => {} })).rejects.toMatchObject({ code: 'BUSY', status: 503, retryAfter: 1 });
    expect(attempts).toBe(3);
    expect(db.pool.waitingCount).toBe(0);
  });

  it('recovers from an actual deadlock without duplicate committed work', async () => {
    const { hackathonId, users } = await createParticipants(db.pool, 2);
    const locked = [signal(), signal()];
    const attempts = [0, 0];
    const published = [0, 0];
    await Promise.all([0, 1].map((index) => withTx(db.pool, async (tx) => {
      attempts[index]! += 1;
      // Test-only detector interval: keep detection comfortably inside the unchanged
      // 2-second application lock timeout. Docker's test role owns this scratch DB.
      await tx.q("SELECT set_config('deadlock_timeout', '50ms', true)");
      await tx.q('UPDATE users SET display_name = $2 WHERE id = $1', [users[index], `Worker ${index}`]);
      if (attempts[index] === 1) {
        locked[index]!.resolve();
        await bounded(locked[1 - index]!.promise);
      }
      await tx.q('UPDATE users SET display_name = $2 WHERE id = $1', [users[1 - index], `Worker ${index}`]);
      await tx.q("INSERT INTO audit_log (hackathon_id, action) VALUES ($1, 'deadlock.probe')", [hackathonId]);
      tx.afterCommit(() => { published[index]! += 1; });
    })));
    expect(attempts.reduce((a, b) => a + b)).toBe(3);
    expect(published).toEqual([1, 1]);
    expect((await db.pool.query('SELECT 1 FROM audit_log WHERE hackathon_id = $1', [hackathonId])).rowCount).toBe(2);
    await assertInvariants(db.pool, hackathonId);
  });

  it('does not retry lock timeouts', async () => {
    const { users } = await createParticipants(db.pool, 1);
    const blocker = await db.pool.connect();
    let attempts = 0;
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT 1 FROM users WHERE id = $1 FOR UPDATE', [users[0]]);
      await expect(withTx(db.pool, async (tx) => {
        attempts += 1;
        await tx.q("SELECT set_config('lock_timeout', '25ms', true)");
        await tx.q('UPDATE users SET display_name = $2 WHERE id = $1', [users[0], 'Blocked']);
      })).rejects.toMatchObject({ code: 'BUSY', retryAfter: 1 });
      expect(attempts).toBe(1);
    } finally { await blocker.query('ROLLBACK'); blocker.release(); }
  });

  it('does not retry statement timeouts', async () => {
    let attempts = 0;
    await expect(withTx(db.pool, async (tx) => {
      attempts += 1;
      await tx.q("SELECT set_config('statement_timeout', '25ms', true)");
      // Deliberately slow server work tests cancellation; no timing-based race coordination.
      await tx.q('SELECT pg_sleep(1)');
    })).rejects.toMatchObject({ code: 'BUSY' });
    expect(attempts).toBe(1);
  });

  it('bounds pool acquisition and never starts work without a connection', async () => {
    const pool = new pg.Pool({ ...db.pool.options, max: 1, connectionTimeoutMillis: 40 });
    const held = await pool.connect();
    let called = false;
    try {
      await expect(withTx(pool, async () => { called = true; }, { report: () => {} }))
        .rejects.toMatchObject({ code: 'BUSY', status: 503 });
      expect(called).toBe(false);
      expect(pool.waitingCount).toBe(0);
    } finally { held.release(); await pool.end(); }
  });

  it('discards a disconnected client and lets a later transaction succeed', async () => {
    const pool = new pg.Pool({ ...db.pool.options, max: 1 });
    let attempts = 0;
    try {
      await expect(withTx(pool, async (tx) => {
        attempts += 1;
        await tx.q('SELECT pg_terminate_backend(pg_backend_pid())');
      }, { report: () => {} })).rejects.toMatchObject({ code: 'INTERNAL' });
      expect(attempts).toBe(1);
      expect(await withTx(pool, async (tx) => (await tx.q('SELECT 42 AS answer')).rows[0]!.answer)).toBe(42);
    } finally { await pool.end(); }
  });
});
