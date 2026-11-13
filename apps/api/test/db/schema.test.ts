import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testDatabase } from '../helpers/database.js';
import { createParticipants, createTeam, membership } from '../helpers/factories.js';
import { withTx } from '../../src/db/tx.js';
import { assertInvariants, checkInvariants } from '../../src/db/invariants.js';
import { createApp } from '../../src/app.js';
import { testServer } from '../helpers/testServer.js';

let db: Awaited<ReturnType<typeof testDatabase>>;
beforeAll(async () => { db = await testDatabase(); });
afterAll(async () => { await db?.dispose(); });

async function fixture(count = 3, max = 4) {
  const { hackathonId, users } = await createParticipants(db.pool, count);
  const leader = users[0]!;
  const teamId = await createTeam(db.pool, hackathonId, leader, max);
  return { hackathonId, users, leader, teamId };
}

describe('PostgreSQL membership safeguards', () => {
  it('allows an incomplete team and serves real database readiness', async () => {
    const f = await fixture();
    const result = await db.pool.query('SELECT member_count, member_count >= min_size AS ready FROM teams WHERE id = $1', [f.teamId]);
    expect(result.rows[0]).toEqual({ member_count: 1, ready: false });
    await assertInvariants(db.pool, f.hackathonId);
    const server = await testServer(createApp({ checkDatabase: async () => { await db.pool.query('SELECT 1'); } }));
    try { expect((await fetch(`${server.url}/ready`)).status).toBe(200); }
    finally { await server.close(); }
  });

  it('rejects overcapacity and rolls back membership, counter and audit together', async () => {
    const f = await fixture(3, 2);
    await withTx(db.pool, async (tx) => {
      await tx.q('SELECT 1 FROM teams WHERE id = $1 FOR UPDATE', [f.teamId]);
      await membership(tx, f.hackathonId, f.teamId, f.users[1]!);
    });
    await expect(withTx(db.pool, async (tx) => {
      await tx.q('SELECT 1 FROM teams WHERE id = $1 FOR UPDATE', [f.teamId]);
      await membership(tx, f.hackathonId, f.teamId, f.users[2]!);
    })).rejects.toMatchObject({ code: 'TEAM_FULL', status: 409 });
    expect((await db.pool.query('SELECT 1 FROM team_members WHERE user_id = $1', [f.users[2]])).rowCount).toBe(0);
    expect((await db.pool.query('SELECT 1 FROM audit_log WHERE target_user_id = $1', [f.users[2]])).rowCount).toBe(0);
    await assertInvariants(db.pool, f.hackathonId);
  });

  it('rejects joining two teams in one hackathon', async () => {
    const f = await fixture();
    const other = await createTeam(db.pool, f.hackathonId, f.users[1]!);
    await expect(withTx(db.pool, async (tx) => {
      await tx.q('SELECT 1 FROM teams WHERE id = $1 FOR UPDATE', [other]);
      await membership(tx, f.hackathonId, other, f.leader);
    })).rejects.toMatchObject({ code: 'ALREADY_IN_TEAM' });
    await assertInvariants(db.pool, f.hackathonId);
  });

  it('rejects membership moved across hackathons and membership UPDATEs', async () => {
    const f = await fixture();
    const other = await createParticipants(db.pool, 1);
    await expect(db.pool.query('INSERT INTO team_members (team_id, hackathon_id, user_id) VALUES ($1,$2,$3)',
      [f.teamId, other.hackathonId, other.users[0]])).rejects.toMatchObject({ code: '23503', constraint: 'team_members_team_fk' });
    await expect(db.pool.query('UPDATE team_members SET joined_at = clock_timestamp() WHERE team_id = $1', [f.teamId]))
      .rejects.toMatchObject({ code: '23514', constraint: 'team_members_immutable' });
    await assertInvariants(db.pool, f.hackathonId);
  });

  it('rejects count tampering at COMMIT, with no after-commit publication', async () => {
    const f = await fixture();
    let published = false;
    const errors: unknown[] = [];
    await expect(withTx(db.pool, async (tx) => {
      await tx.q('UPDATE teams SET member_count = 2 WHERE id = $1', [f.teamId]);
      tx.afterCommit(() => { published = true; });
    }, { report: (_event, error) => errors.push(error) })).rejects.toMatchObject({ code: 'INTERNAL' });
    expect(errors).toEqual([expect.objectContaining({ constraint: 'teams_member_count_matches' })]);
    expect(published).toBe(false);
    await assertInvariants(db.pool, f.hackathonId);
  });

  it('defers leadership validation until COMMIT and restores the removed leader on failure', async () => {
    const f = await fixture();
    let reachedEnd = false;
    const errors: unknown[] = [];
    await expect(withTx(db.pool, async (tx) => {
      await tx.q('SELECT 1 FROM teams WHERE id = $1 FOR UPDATE', [f.teamId]);
      await tx.q('DELETE FROM team_members WHERE team_id = $1 AND user_id = $2', [f.teamId, f.leader]);
      reachedEnd = true;
    }, { report: (_event, error) => errors.push(error) })).rejects.toMatchObject({ code: 'INTERNAL' });
    expect(reachedEnd).toBe(true);
    expect(errors).toEqual([expect.objectContaining({ constraint: 'teams_leader_is_member_fk' })]);
    await assertInvariants(db.pool, f.hackathonId);
  });

  it('permits promotion and last-member deletion while preserving audit history', async () => {
    const f = await fixture();
    await withTx(db.pool, async (tx) => {
      await tx.q('SELECT 1 FROM teams WHERE id = $1 FOR UPDATE', [f.teamId]);
      await membership(tx, f.hackathonId, f.teamId, f.users[1]!);
      await tx.q('DELETE FROM team_members WHERE team_id = $1 AND user_id = $2', [f.teamId, f.leader]);
      await tx.q('UPDATE teams SET leader_id = $2 WHERE id = $1', [f.teamId, f.users[1]]);
    });
    await assertInvariants(db.pool, f.hackathonId);
    await withTx(db.pool, async (tx) => {
      await tx.q('SELECT 1 FROM teams WHERE id = $1 FOR UPDATE', [f.teamId]);
      await tx.q('DELETE FROM team_members WHERE team_id = $1', [f.teamId]);
      await tx.q('DELETE FROM teams WHERE id = $1 AND member_count = 0', [f.teamId]);
    });
    expect((await db.pool.query('SELECT 1 FROM teams WHERE id = $1', [f.teamId])).rowCount).toBe(0);
    expect((await db.pool.query('SELECT 1 FROM audit_log WHERE team_id = $1', [f.teamId])).rowCount).toBe(2);
    await assertInvariants(db.pool, f.hackathonId);
  });

  it('keeps audit history append-only and increments version on updates', async () => {
    const f = await fixture();
    const before = await db.pool.query('SELECT version FROM teams WHERE id = $1', [f.teamId]);
    const after = await db.pool.query('UPDATE teams SET description = $2 WHERE id = $1 RETURNING version', [f.teamId, 'Edited']);
    expect(BigInt(after.rows[0].version)).toBe(BigInt(before.rows[0].version) + 1n);
    await expect(db.pool.query('DELETE FROM audit_log WHERE team_id = $1', [f.teamId])).rejects.toMatchObject({ code: '42501' });
    await expect(db.pool.query("UPDATE audit_log SET action = 'fake' WHERE team_id = $1", [f.teamId])).rejects.toMatchObject({ code: '42501' });
    await assertInvariants(db.pool, f.hackathonId);
  });

  it('enforces pending-request uniqueness and terminal decision timestamps', async () => {
    const f = await fixture();
    const params = [f.hackathonId, f.teamId, f.users[1]];
    await db.pool.query('INSERT INTO join_requests (hackathon_id, team_id, user_id) VALUES ($1,$2,$3)', params);
    await expect(db.pool.query('INSERT INTO join_requests (hackathon_id, team_id, user_id) VALUES ($1,$2,$3)', params))
      .rejects.toMatchObject({ code: '23505', constraint: 'join_requests_one_pending_uq' });
    await expect(db.pool.query("UPDATE join_requests SET status = 'declined' WHERE team_id = $1", [f.teamId]))
      .rejects.toMatchObject({ code: '23514', constraint: 'join_requests_decided_chk' });
    await assertInvariants(db.pool, f.hackathonId);
  });

  it('detects missing application audit/cancellation work and scopes it to its hackathon', async () => {
    const good = await fixture();
    const bad = await createParticipants(db.pool, 1);
    const team = await createTeam(db.pool, bad.hackathonId, bad.users[0]!, 4, false);
    await db.pool.query('INSERT INTO join_requests (hackathon_id, team_id, user_id) VALUES ($1,$2,$3)', [bad.hackathonId, team, bad.users[0]]);
    await assertInvariants(db.pool, good.hackathonId);
    const failures = (await checkInvariants(db.pool, bad.hackathonId)).filter((r) => r.violations.length);
    expect(failures.map((r) => r.id)).toEqual(['B.7', 'B.8']);
    // This deliberately dirty fixture is confined to this suite's disposable schema.
  });
});
