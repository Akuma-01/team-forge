import { mkdir, writeFile } from 'node:fs/promises';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { raceFixture, outcome } from '../helpers/raceFixture.js';
import type { RaceFixture } from '../helpers/raceFixture.js';
import { fireAtOnce } from '../helpers/concurrency.js';

describe('50 authenticated participants competing for seats over HTTP', () => {
  let fixture: RaceFixture;
  const reports: unknown[] = [];
  const attempts: Array<{ iteration: number; passed: boolean; histogram?: Record<string, number> }> = [];
  const clockChanges: Array<{ monotonicMs: number; wallClockDriftMs: number }> = [];
  let clockTimer: ReturnType<typeof setInterval>;
  let postgresVersion = '';
  const evidence = () => ({ node: process.version, postgres: postgresVersion, poolMax: 20,
    topology: 'One server; distinct real loopback source IP per participant; normal authentication and rate limits',
    requiredLastSeatIterations: 20, completedLastSeatIterations: reports.length,
    headlinePassed: reports.length === 20, attempts, clockChanges, iterations: reports });
  beforeAll(async () => {
    let previous = { wall: Date.now(), monotonic: performance.now() };
    // Read-only diagnostics: clock corrections never skip a case, change a
    // timeout, trigger retries or turn a failed assertion into a success.
    clockTimer = setInterval(() => {
      const now = { wall: Date.now(), monotonic: performance.now() };
      const drift = now.wall - previous.wall - (now.monotonic - previous.monotonic);
      if (Math.abs(drift) > 100) clockChanges.push({ monotonicMs: now.monotonic, wallClockDriftMs: drift });
      previous = now;
    }, 20);
    await mkdir('.cache/phase4', { recursive: true });
    await writeFile('.cache/phase4/last-seat.json', JSON.stringify(evidence(), null, 2) + '\n');
  });
  afterAll(async () => {
    clearInterval(clockTimer);
    await writeFile('.cache/phase4/last-seat.json', JSON.stringify(evidence(), null, 2) + '\n');
  });
  beforeEach(async () => { fixture = await raceFixture(); });
  afterEach(async () => {
    if (!fixture) return;
    try { await fixture.idle(); await fixture.invariantReport(); }
    finally { await fixture.dispose(); }
  });

  async function compete(initialMembers: number[], attempt?: typeof attempts[number]) {
    const team = await fixture.team(initialMembers);
    fixture.published.length = 0;
    const contenders = Array.from({ length: 50 }, (_, i) => i + 4);
    const responses = await fireAtOnce(contenders.map((actor) => () => fixture.join(actor, team.inviteCode!)));
    const histogram: Record<string, number> = {};
    for (const response of responses) histogram[outcome(response)] = (histogram[outcome(response)] ?? 0) + 1;
    if (attempt) attempt.histogram = histogram;
    const seats = 4 - initialMembers.length;
    expect(histogram).toEqual(seats === 0 ? { '409:TEAM_FULL': 50 } : { '200': seats, '409:TEAM_FULL': 50 - seats });
    expect(new Set(responses.map((r) => r.sourceAddress)).size).toBe(50);
    expect(new Set(responses.map((r) => r.userId)).size).toBe(50);
    const winners = responses.filter((r) => r.status === 200);
    for (const winner of winners) {
      expect(winner.body.alreadyMember).toBe(false);
      expect(winner.body.team.inviteCode).toBeUndefined();
      expect(winner.body.team.memberCount).toBeLessThanOrEqual(4);
    }
    const expectedMembers = [...initialMembers.map((i) => fixture.actors[i]!.id), ...winners.map((r) => r.userId)].sort();
    const members = (await fixture.pool.query<{ user_id: string }>('SELECT user_id FROM team_members WHERE team_id=$1 ORDER BY user_id', [team.id])).rows.map((r) => r.user_id);
    expect(members).toEqual(expectedMembers);
    expect((await fixture.pool.query('SELECT member_count FROM teams WHERE id=$1', [team.id])).rows).toEqual([{ member_count: 4 }]);
    const contestantIds = contenders.map((i) => fixture.actors[i]!.id);
    expect((await fixture.pool.query('SELECT actor_id FROM audit_log WHERE actor_id=ANY($1::uuid[]) ORDER BY actor_id', [contestantIds])).rows)
      .toEqual(winners.map((r) => ({ actor_id: r.userId })).sort((a, b) => a.actor_id.localeCompare(b.actor_id)));
    expect((await fixture.pool.query('SELECT user_id FROM idempotency_keys WHERE user_id=ANY($1::uuid[]) ORDER BY user_id', [contestantIds])).rows)
      .toEqual(winners.map((r) => ({ user_id: r.userId })).sort((a, b) => a.user_id.localeCompare(b.user_id)));
    expect(fixture.published).toEqual(winners.map(() => ({ hackathonId: fixture.hackathonId, teamId: team.id, deleted: false })));
    const invariants = await fixture.invariantReport();
    await fixture.idle();
    postgresVersion = (await fixture.pool.query<{ server_version: string }>('SHOW server_version')).rows[0]!.server_version;
    return { hackathonId: fixture.hackathonId, teamId: team.id, histogram, members, winners: winners.map((r) => r.userId), invariants, connections: fixture.connections() };
  }

  for (let iteration = 1; iteration <= 20; iteration++) {
    it(`last seat: exactly 1 success and 49 TEAM_FULL, fresh fixture ${iteration}/20`, async () => {
      const attempt = { iteration, passed: false };
      attempts.push(attempt);
      reports.push({ iteration, ...await compete([0, 1, 2], attempt) });
      attempt.passed = true;
    });
  }
  it('two seats: exactly 2 successes and 48 TEAM_FULL', async () => { await compete([0, 1]); });
  it('no seats: all 50 get TEAM_FULL without effects', async () => { await compete([0, 1, 2, 3]); });
});
