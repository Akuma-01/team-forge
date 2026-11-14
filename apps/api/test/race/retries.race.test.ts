import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { raceFixture, outcome } from '../helpers/raceFixture.js';
import type { RaceFixture } from '../helpers/raceFixture.js';
import { fireAtOnce, waitForBlock } from '../helpers/concurrency.js';
import { bounded, signal } from '../helpers/signals.js';

describe('HTTP mutation retries and rollback', () => {
  let fixture: RaceFixture | undefined;
  afterEach(async () => {
    if (!fixture) return;
    try { await fixture.idle(); await fixture.invariantReport(); }
    finally { await fixture.dispose(); fixture = undefined; }
  });
  async function counts() {
    return (await fixture!.pool.query(`SELECT
      (SELECT count(*)::integer FROM teams) AS teams,
      (SELECT count(*)::integer FROM team_members) AS members,
      (SELECT count(*)::integer FROM audit_log) AS audits,
      (SELECT count(*)::integer FROM idempotency_keys) AS keys`)).rows[0];
  }

  it('a real PostgreSQL deadlock retries the victim without duplicating domain effects', async () => {
    const owners = new Map<number, string>();
    const attempts = new Map<string, number>();
    const previous = new Map<string, number>();
    const locked = [signal(), signal()];
    const failures: string[] = [];
    const f = fixture = await raceFixture(2, { observe: async (event) => {
      if (event.phase === 'before' && event.sql.startsWith('INSERT INTO idempotency_keys')) {
        const owner = String(event.params[0]);
        const last = previous.get(owner);
        if (last !== undefined) expect(fixture!.instrumented!.released).toContain(last);
        previous.set(owner, event.checkout); owners.set(event.checkout, owner);
        attempts.set(owner, (attempts.get(owner) ?? 0) + 1);
      }
      if (event.sql !== 'COMMIT') return;
      if (event.phase === 'error') { failures.push((event.error as { code: string }).code); return; }
      const owner = owners.get(event.checkout);
      if (event.phase !== 'before' || !owner || attempts.get(owner) !== 1) return;
      const actor = fixture!.actors.findIndex((a) => a.id === owner);
      // Only the detector is accelerated. Runtime lock/statement/idle timeouts
      // remain 2s/5s/10s. The two UPDATEs form an actual PostgreSQL lock cycle.
      await event.query("SET LOCAL deadlock_timeout = '50ms'");
      await event.query('UPDATE race_locks SET value=value+1 WHERE id=$1', [actor + 1]);
      locked[actor]!.resolve();
      await bounded(locked[1 - actor]!.promise);
      await event.query('UPDATE race_locks SET value=value+1 WHERE id=$1', [2 - actor]);
    } });
    await f.pool.query('CREATE TABLE race_locks (id integer PRIMARY KEY, value integer NOT NULL); INSERT INTO race_locks VALUES (1,0),(2,0)');
    const results = await fireAtOnce([0, 1].map((actor) => () => f.call(actor, '/teams', { name: `Deadlock ${actor}` })));
    expect(results.map(outcome)).toEqual(['201', '201']);
    expect(failures).toEqual(['40P01']);
    expect([...attempts.values()].sort()).toEqual([1, 2]);
    expect(await counts()).toEqual({ teams: 2, members: 2, audits: 2, keys: 2 });
    expect(f.published).toHaveLength(2);
    expect(new Set(f.published.map((change) => change.teamId)).size).toBe(2);
    // The injected cycle only runs on first attempts; the victim's increments
    // roll back. Only the non-victim's two diagnostic increments survive.
    expect((await f.pool.query('SELECT value FROM race_locks ORDER BY id')).rows).toEqual([{ value: 1 }, { value: 1 }]);
  });

  for (const code of ['40001', '40P01', '57014', '55P03']) {
    it(`SQLSTATE ${code} after domain writes rolls back effects with bounded attempts`, async () => {
      let attempts = 0;
      let previous: number | undefined;
      let inject = true;
      const f = fixture = await raceFixture(1, { observe: async (event) => {
        if (event.phase === 'before' && event.sql.startsWith('INSERT INTO idempotency_keys')) {
          if (previous !== undefined) expect(fixture!.instrumented!.released).toContain(previous);
          previous = event.checkout; attempts++;
        }
        if (inject && event.phase === 'before' && event.sql === 'COMMIT') {
          // A genuine server error aborts the real transaction after its domain,
          // audit and idempotency writes. No pg response or Error is fabricated.
          await event.query(`DO $$ BEGIN RAISE EXCEPTION 'injected test fault' USING ERRCODE = '${code}'; END $$`);
        }
      } });
      const key = randomUUID();
      const failed = await f.call(0, '/teams', { name: 'Retry intent' }, key);
      expect(outcome(failed)).toBe('503:BUSY');
      expect(failed.headers['retry-after']).toBe('1');
      expect(attempts).toBe(['40001', '40P01'].includes(code) ? 3 : 1);
      expect(await counts()).toEqual({ teams: 0, members: 0, audits: 0, keys: 0 });
      expect(f.published).toHaveLength(0);
      await f.idle();
      inject = false;
      const success = await f.call(0, '/teams', { name: 'Retry intent' }, key);
      expect(outcome(success)).toBe('201');
      expect(success.headers['idempotent-replay']).toBeUndefined();
      expect(await counts()).toEqual({ teams: 1, members: 1, audits: 1, keys: 1 });
      expect(f.published).toHaveLength(1);
    });
  }

  it('a real 2-second team lock timeout returns BUSY once, then the same key can succeed', async () => {
    let enabled = false; let attempts = 0; let waiterPid = 0;
    const waiting = signal();
    const f = fixture = await raceFixture(2, { observe: (event) => {
      if (!enabled || event.phase !== 'before') return;
      if (event.sql.startsWith('INSERT INTO idempotency_keys')) attempts++;
      if (event.sql.startsWith('SELECT id, leader_id') && event.sql.endsWith('FOR UPDATE')) { waiterPid = event.pid; waiting.resolve(); }
    } });
    const team = await f.create(0); f.published.length = 0;
    const blocker = await f.pool.connect();
    let blockedRequest: ReturnType<typeof f.join> | undefined;
    const key = randomUUID();
    try {
      await blocker.query('BEGIN');
      const blockerPid = (await blocker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
      await blocker.query('SELECT id FROM teams WHERE id=$1 FOR UPDATE', [team.id]);
      enabled = true;
      blockedRequest = f.join(1, team.inviteCode!, key);
      await bounded(waiting.promise);
      await waitForBlock(f.observer, waiterPid, blockerPid);
      const result = await blockedRequest;
      expect(outcome(result)).toBe('503:BUSY');
      expect(result.headers['retry-after']).toBe('1');
      expect(attempts).toBe(1);
      expect(await counts()).toEqual({ teams: 1, members: 1, audits: 1, keys: 1 });
      expect(f.published).toHaveLength(0);
    } finally { await blocker.query('ROLLBACK'); blocker.release(); await blockedRequest; }
    expect(outcome(await f.join(1, team.inviteCode!, key))).toBe('200');
    expect(await counts()).toEqual({ teams: 1, members: 2, audits: 2, keys: 2 });
    expect(f.published).toHaveLength(1);
  });

  it('publication failure after commit cannot retry the mutation or publish its replay', async () => {
    let publications = 0;
    const f = fixture = await raceFixture(1, { observe: () => {}, publish: () => {
      expect(fixture!.instrumented!.active.size).toBe(0);
      publications++;
      throw new Error('Injected publication failure');
    } });
    const key = randomUUID();
    const first = await f.call(0, '/teams', { name: 'Committed' }, key);
    const replay = await f.call(0, '/teams', { name: 'Committed' }, key);
    expect([outcome(first), outcome(replay)]).toEqual(['201', '201']);
    expect(replay.body).toEqual(first.body);
    expect(replay.headers['idempotent-replay']).toBe('true');
    expect(publications).toBe(1);
    expect(await counts()).toEqual({ teams: 1, members: 1, audits: 1, keys: 1 });
    expect(f.published).toHaveLength(1);
  });
});
