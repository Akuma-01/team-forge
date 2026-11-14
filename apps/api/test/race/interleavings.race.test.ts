import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { raceFixture, outcome } from '../helpers/raceFixture.js';
import type { RaceFixture } from '../helpers/raceFixture.js';
import type { QueryObserver } from '../helpers/observePool.js';
import { fireAtOnce, waitForBlock } from '../helpers/concurrency.js';
import { bounded, signal } from '../helpers/signals.js';

describe('core team interleavings over HTTP', () => {
  let fixture: RaceFixture | undefined;
  afterEach(async () => {
    if (!fixture) return;
    try { await fixture.idle(); await fixture.invariantReport(); }
    finally { await fixture.dispose(); fixture = undefined; }
  });
  async function effects() {
    return (await fixture!.pool.query(`SELECT
      (SELECT count(*)::integer FROM teams) AS teams,
      (SELECT count(*)::integer FROM team_members) AS members,
      (SELECT count(*)::integer FROM idempotency_keys) AS keys,
      (SELECT count(*)::integer FROM audit_log) AS audits`)).rows[0];
  }
  it('20 simultaneous identical creates commit once and replay the exact result', async () => {
    const f = fixture = await raceFixture(1);
    const key = randomUUID();
    const results = await fireAtOnce(Array.from({ length: 20 }, () => () => f.call(0, '/teams', { name: 'One team' }, key)));
    expect(results.map(outcome)).toEqual(Array(20).fill('201'));
    for (const result of results) expect(result.body).toEqual(results[0]!.body);
    expect(results.filter((r) => r.headers['idempotent-replay'] === 'true')).toHaveLength(19);
    expect(await effects()).toEqual({ teams: 1, members: 1, keys: 1, audits: 1 });
    expect(f.published).toHaveLength(1);
  });
  it('10 simultaneous identical joins replay one membership and notification', async () => {
    const f = fixture = await raceFixture(2);
    const team = await f.create(0);
    f.published.length = 0;
    const key = randomUUID();
    const results = await fireAtOnce(Array.from({ length: 10 }, () => () => f.join(1, team.inviteCode!, key)));
    expect(results.map(outcome)).toEqual(Array(10).fill('200'));
    for (const result of results) expect(result.body).toEqual(results[0]!.body);
    expect(results.filter((r) => r.headers['idempotent-replay'] === 'true')).toHaveLength(9);
    expect(await effects()).toEqual({ teams: 1, members: 2, keys: 2, audits: 2 });
    expect(f.published).toHaveLength(1);
  });
  it('one user joins 10 different teams simultaneously and belongs to exactly one', async () => {
    const f = fixture = await raceFixture(11);
    const teams = [];
    for (let actor = 0; actor < 10; actor++) teams.push(await f.create(actor));
    f.published.length = 0;
    const results = await fireAtOnce(teams.map((team) => () => f.join(10, team.inviteCode!)));
    expect(results.map(outcome).sort()).toEqual(['200', ...Array<string>(9).fill('409:ALREADY_IN_TEAM')]);
    const winner = results.find((r) => r.status === 200)!;
    expect((await f.pool.query('SELECT team_id FROM team_members WHERE user_id=$1', [f.actors[10]!.id])).rows).toEqual([{ team_id: winner.body.team.id }]);
    expect(await effects()).toEqual({ teams: 10, members: 11, keys: 11, audits: 11 });
    expect(f.published).toHaveLength(1);
  });

  // Stop the first transaction AFTER its actual team lock. Observe the second
  // BEFORE its lock query, then use pg_blocking_pids to prove the ordering.
  function teamBarrier(firstActor: () => string, secondActor: () => string) {
    const owners = new Map<number, string>();
    const locked = signal(); const waiting = signal(); const release = signal();
    let firstPid = 0; let secondPid = 0;
    let enabled = false;
    const observe: QueryObserver = async (event) => {
      if (event.sql.includes('hackathon_participants') && event.sql.includes('FOR NO KEY UPDATE')) owners.set(event.checkout, String(event.params[1]));
      if (!enabled || !event.sql.startsWith('SELECT id, leader_id') || !event.sql.endsWith('FOR UPDATE')) return;
      const owner = owners.get(event.checkout);
      if (event.phase === 'after' && owner === firstActor()) {
        firstPid = event.pid; locked.resolve(); await bounded(release.promise);
      }
      if (event.phase === 'before' && owner === secondActor()) { secondPid = event.pid; waiting.resolve(); }
    };
    return { observe, locked, waiting, release, enable: () => { enabled = true; }, prove: async (f: RaceFixture) => {
      await bounded(waiting.promise); await waitForBlock(f.observer, secondPid, firstPid);
    } };
  }

  for (const first of [0, 1]) {
    it(`two simultaneous leaves: ${first === 0 ? 'leader' : 'member'} takes the team lock first`, async () => {
      const barrier = teamBarrier(() => fixture!.actors[first]!.id, () => fixture!.actors[1 - first]!.id);
      const f = fixture = await raceFixture(2, { observe: barrier.observe });
      const team = await f.team([0, 1]); f.published.length = 0; barrier.enable();
      const started = [f.call(first, `/teams/${team.id}/leave`, {})];
      try {
        await bounded(barrier.locked.promise);
        started.push(f.call(1 - first, `/teams/${team.id}/leave`, {}));
        await barrier.prove(f);
      } finally { barrier.release.resolve(); await Promise.allSettled(started); }
      expect((await Promise.all(started)).map(outcome)).toEqual(['200', '200']);
      expect(await effects()).toEqual({ teams: 0, members: 0, keys: 4, audits: first === 0 ? 6 : 5 });
      expect((await f.pool.query('SELECT action FROM audit_log WHERE action IN (\'member.left\',\'team.deleted\',\'leader.changed\') ORDER BY action')).rows.map((r) => r.action))
        .toEqual([...(first === 0 ? ['leader.changed'] : []), 'member.left', 'member.left', 'team.deleted']);
      expect(f.published.map((change) => change.deleted)).toEqual([false, true]);
    });
  }

  for (const joinFirst of [true, false]) {
    it(`last member leaves while another joins: ${joinFirst ? 'join' : 'leave'} takes the team lock first`, async () => {
      const barrier = teamBarrier(() => fixture!.actors[joinFirst ? 1 : 0]!.id, () => fixture!.actors[joinFirst ? 0 : 1]!.id);
      const f = fixture = await raceFixture(2, { observe: barrier.observe });
      const team = await f.create(0); f.published.length = 0; barrier.enable();
      const join = () => f.join(1, team.inviteCode!);
      const leave = () => f.call(0, `/teams/${team.id}/leave`, {});
      const started = [joinFirst ? join() : leave()];
      try {
        await bounded(barrier.locked.promise);
        started.push(joinFirst ? leave() : join());
        await barrier.prove(f);
      } finally { barrier.release.resolve(); await Promise.allSettled(started); }
      expect((await Promise.all(started)).map(outcome)).toEqual(joinFirst ? ['200', '200'] : ['200', '404:INVALID_OR_EXPIRED_CODE']);
      expect(await effects()).toEqual(joinFirst ? { teams: 1, members: 1, keys: 3, audits: 4 } : { teams: 0, members: 0, keys: 2, audits: 3 });
      expect((await f.pool.query('SELECT leader_id, member_count FROM teams')).rows).toEqual(joinFirst ? [{ leader_id: f.actors[1]!.id, member_count: 1 }] : []);
      expect((await f.pool.query('SELECT user_id FROM team_members')).rows).toEqual(joinFirst ? [{ user_id: f.actors[1]!.id }] : []);
      expect(f.published).toHaveLength(joinFirst ? 2 : 1);
    });
  }
});
