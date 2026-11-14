import { randomUUID } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import { decodeJwt, SignJWT } from 'jose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { apiErrorSchema } from '@teamforge/shared';
import type { CreateTeamResult, JoinTeamResult, TeamDetail, MyTeam } from '@teamforge/shared';
import { createApp } from '../../src/app.js';
import { readConfig } from '../../src/config.js';
import { issuer, audience } from '../../src/modules/auth/session.js';
import { inviteCode } from '../../src/modules/teams/invite.js';
import type { TeamChange } from '../../src/modules/teams/service.js';
import { assertInvariants } from '../../src/db/invariants.js';
import { withTx } from '../../src/db/tx.js';
import { testDatabase } from '../helpers/database.js';
import { createParticipants, membership } from '../helpers/factories.js';
import { testServer } from '../helpers/testServer.js';

let db: Awaited<ReturnType<typeof testDatabase>>;
let server: Awaited<ReturnType<typeof testServer>>;
let hid: string;
let users: string[];
let cookies: string[];
let changes: TeamChange[];
const origin = 'http://localhost:5173';

async function request(user: number, suffix: string, method = 'GET', body?: unknown, key?: string, headers: Record<string, string> = {}) {
  const response = await fetch(`${server.url}/api/hackathons/${hid}${suffix}`, {
    method, headers: { Origin: origin, ...(user >= 0 ? { Cookie: cookies[user]! } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(key !== undefined ? { 'Idempotency-Key': key } : {}), ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (user >= 0 && response.status === 401) {
    const claims = decodeJwt(cookies[user]!.slice(4));
    const exists = (await db.pool.query('SELECT 1 FROM users WHERE id=$1', [users[user]])).rowCount === 1;
    throw new Error(`Unexpected fixture session rejection: age=${Math.floor(Date.now() / 1000) - claims.iat!}s lifetime=${claims.exp! - claims.iat!}s userExists=${exists}`);
  }
  return response;
}
async function create(user = 0, body: Record<string, unknown> = { name: 'First team' }, key?: string) {
  const response = await request(user, '/teams', 'POST', body, key);
  expect(response.status).toBe(201);
  return (await response.json() as CreateTeamResult).team;
}
async function join(user: number, code: string, key?: string) {
  const response = await request(user, '/teams/join-by-code', 'POST', { code }, key);
  expect(response.status).toBe(200);
  return await response.json() as JoinTeamResult;
}
const counts = async () => (await db.pool.query(`SELECT
  (SELECT count(*)::int FROM teams WHERE hackathon_id=$1) AS teams,
  (SELECT count(*)::int FROM team_members WHERE hackathon_id=$1) AS members,
  (SELECT count(*)::int FROM audit_log WHERE hackathon_id=$1) AS audit`, [hid])).rows[0];

beforeAll(async () => { db = await testDatabase(); });
beforeEach(async () => {
  const participants = await createParticipants(db.pool, 7);
  hid = participants.hackathonId; users = participants.users;
  const config = readConfig({ DATABASE_URL: db.connectionString, JWT_SECRET: 'team-tests-only-secret-0123456789abcdef', APP_ORIGIN: origin, NODE_ENV: 'test' });
  // Domain tests use already-established sessions. Backdate their signed issue
  // time by a minute to tolerate local wall-clock corrections observed in WSL
  // without relaxing the application's future-token or expiry validation.
  // Signup/login and exact issuance behavior remain covered by the auth suites.
  const issuedAt = Math.floor(Date.now() / 1000) - 60;
  const secret = new TextEncoder().encode(config.JWT_SECRET);
  cookies = await Promise.all(users.map(async (id) => `sid=${await new SignJWT({})
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' }).setSubject(id).setIssuer(issuer).setAudience(audience)
    .setIssuedAt(issuedAt).setExpirationTime(issuedAt + 604800).sign(secret)}`));
  changes = [];
  server = await testServer(createApp({ checkDatabase: async () => {}, identity: { pool: db.pool, config,
    publishTeamChange: async (change) => {
      // Hooks can only observe committed state, and run after releasing the write connection.
      await assertInvariants(db.pool, hid); changes.push(change);
    },
  } }));
});
afterEach(async () => { await server?.close(); await assertInvariants(db.pool, hid); });
afterAll(async () => { await db?.dispose(); });

describe('core team lifecycle over HTTP', () => {
  it('creates the leader membership, snapshots hackathon sizes, and scopes private fields to the leader', async () => {
    const team = await create(0, { name: '  Makers  ', description: 'Build together', lookingFor: ['design'], isOpen: false });
    expect(team).toMatchObject({ name: 'Makers', description: 'Build together', lookingFor: ['design'], minSize: 2, maxSize: 4, memberCount: 1, openSeats: 3, ready: false, isOpen: false, leader: { id: users[0] } });
    expect(team.inviteCode).toMatch(/^[0-9A-HJKMNP-TV-Z]{10}$/);
    expect(Date.parse(team.inviteExpiresAt!) - Date.now()).toBeGreaterThan(47 * 3600_000);
    expect(team.members).toHaveLength(1);
    expect(team.members[0]).toMatchObject({ userId: users[0], isLeader: true });
    expect((await request(0, `/teams/${team.id}`)).status).toBe(200);
    const outsider = await (await request(1, `/teams/${team.id}`)).json() as TeamDetail;
    expect(outsider.inviteCode).toBeUndefined(); expect(outsider.inviteExpiresAt).toBeUndefined(); expect(outsider.pendingRequestCount).toBeUndefined();
    expect(JSON.stringify(team)).not.toMatch(/password|email|is_organizer/);
    expect((await (await request(1, '/me/team')).json() as MyTeam).team).toBeNull();
    const { rows: [audit] } = await db.pool.query('SELECT action, target_user_id, request_id FROM audit_log WHERE team_id=$1', [team.id]);
    expect(audit).toMatchObject({ action: 'team.created', target_user_id: users[0] });
    expect(audit.request_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(changes).toEqual([{ hackathonId: hid, teamId: team.id, deleted: false }]);
  });

  it('joins a closed team with a valid private invite and returns alreadyMember on a keyless repeat', async () => {
    const team = await create(0, { name: 'Private team', isOpen: false });
    const joined = await join(1, team.inviteCode!.toLowerCase());
    expect(joined.alreadyMember).toBe(false); expect(joined.team.memberCount).toBe(2); expect(joined.team.ready).toBe(true);
    expect(joined.team.inviteCode).toBeUndefined();
    expect((await join(1, team.inviteCode!)).alreadyMember).toBe(true);
    expect(await counts()).toEqual({ teams: 1, members: 2, audit: 2 });
    expect(changes).toHaveLength(2);
  });

  it('leaves, promotes the longest-tenured remaining member, then deletes the last-member team while retaining audit', async () => {
    const team = await create();
    await join(1, team.inviteCode!); await join(2, team.inviteCode!);
    expect(await (await request(0, `/teams/${team.id}/leave`, 'POST', {})).json()).toEqual({ left: true, teamDeleted: false });
    const promoted = (await (await request(1, '/me/team')).json() as MyTeam).team!;
    expect(promoted.leader.id).toBe(users[1]); expect(promoted.inviteCode).toBe(team.inviteCode); expect(promoted.memberCount).toBe(2);
    expect((await (await request(0, `/teams/${team.id}`)).json() as TeamDetail).inviteCode).toBeUndefined();
    expect((await request(0, `/teams/${team.id}/leave`, 'POST')).status).toBe(404);
    expect((await request(2, `/teams/${team.id}/leave`, 'POST')).status).toBe(200);
    const key = randomUUID();
    const leave = await request(1, `/teams/${team.id}/leave`, 'POST', {}, key);
    expect(await leave.json()).toEqual({ left: true, teamDeleted: true });
    const replay = await request(1, `/teams/${team.id}/leave`, 'POST', {}, key);
    expect(replay.headers.get('idempotent-replay')).toBe('true');
    expect(await replay.json()).toEqual({ left: true, teamDeleted: true });
    expect((await request(1, `/teams/${team.id}`)).status).toBe(404);
    expect(await counts()).toEqual({ teams: 0, members: 0, audit: 8 });
    expect((await db.pool.query("SELECT details FROM audit_log WHERE team_id=$1 AND action='team.deleted'", [team.id])).rows[0]?.details).toEqual({ reason: 'last_member_left' });
    expect(changes.at(-1)).toEqual({ hackathonId: hid, teamId: team.id, deleted: true });
  });

  it('breaks a tenure tie deterministically by user UUID', async () => {
    const team = await create();
    await withTx(db.pool, async (tx) => {
      await tx.q('SELECT 1 FROM teams WHERE id=$1 FOR UPDATE', [team.id]);
      // Both fixture inserts share transaction-start now(), making a real tenure tie.
      await membership(tx, hid, team.id, users[1]!); await membership(tx, hid, team.id, users[2]!);
    });
    expect((await request(0, `/teams/${team.id}/leave`, 'POST')).status).toBe(200);
    const successor = [users[1]!, users[2]!].sort()[0];
    expect((await db.pool.query('SELECT leader_id FROM teams WHERE id=$1', [team.id])).rows[0]?.leader_id).toBe(successor);
  });

  it('cancels pending requests with audit on creation and joining, and cascades requests on deletion', async () => {
    const destination = await create(0, { name: 'Destination' });
    const other = await create(1, { name: 'Other' });
    for (const user of [2, 3, 4]) await db.pool.query('INSERT INTO join_requests (hackathon_id, team_id, user_id) VALUES ($1,$2,$3)', [hid, other.id, users[user]]);
    await join(2, destination.inviteCode!); await create(3, { name: 'New creator' });
    const requests = await db.pool.query('SELECT user_id, status, decided_at FROM join_requests WHERE team_id=$1 ORDER BY user_id', [other.id]);
    expect(requests.rows.filter((row) => row.status === 'cancelled' && row.decided_at !== null)).toHaveLength(2);
    expect((await db.pool.query("SELECT * FROM audit_log WHERE team_id=$1 AND action='request.cancelled'", [other.id])).rowCount).toBe(2);
    expect((await request(1, `/teams/${other.id}/leave`, 'POST')).status).toBe(200);
    expect((await db.pool.query('SELECT * FROM join_requests WHERE team_id=$1', [other.id])).rowCount).toBe(0);
    expect((await db.pool.query('SELECT * FROM audit_log WHERE team_id=$1', [other.id])).rowCount).toBe(5);
  });

  it('rejects unauthenticated/unregistered actors, cross-hackathon IDs, unknown fields and invalid keys', async () => {
    expect((await request(-1, '/teams', 'POST', { name: 'Anonymous' })).status).toBe(401);
    await db.pool.query('DELETE FROM hackathon_participants WHERE hackathon_id=$1 AND user_id=$2', [hid, users[6]]);
    expect((await request(6, '/teams', 'POST', { name: 'Unregistered' })).status).toBe(403);
    expect((await request(6, '/me/team')).status).toBe(403);
    for (const extra of [{ leaderId: users[1] }, { maxSize: 10 }, { memberCount: 0 }, { lookingFor: ['bad'] }]) {
      expect((await request(0, '/teams', 'POST', { name: 'Injection', ...extra })).status).toBe(400);
    }
    expect((await request(0, '/teams', 'POST', { name: 'Valid team' }, 'not-a-uuid')).status).toBe(400);
    expect((await request(0, '/teams/not-a-uuid/leave', 'POST')).status).toBe(400);
    const team = await create();
    expect((await request(1, `/teams/${team.id}/leave`, 'POST', { userId: users[0] })).status).toBe(400);
    const oldHid = hid; hid = (await createParticipants(db.pool, 1)).hackathonId;
    try {
      await db.pool.query('INSERT INTO hackathon_participants (hackathon_id,user_id) VALUES ($1,$2)', [hid, users[0]]);
      expect((await request(0, `/teams/${team.id}`)).status).toBe(404);
      expect((await request(0, '/teams/join-by-code', 'POST', { code: team.inviteCode })).status).toBe(404);
    } finally { hid = oldHid; }
    expect(await counts()).toEqual({ teams: 1, members: 1, audit: 1 });
  });

  it('rejects duplicate names and another membership without creating partial records', async () => {
    const team = await create();
    const duplicate = await request(1, '/teams', 'POST', { name: 'first TEAM' }, randomUUID());
    expect(duplicate.status).toBe(409); expect(apiErrorSchema.parse(await duplicate.json()).error.code).toBe('TEAM_NAME_TAKEN');
    const other = await create(1, { name: 'Other team' });
    const joined = await request(0, '/teams/join-by-code', 'POST', { code: other.inviteCode });
    expect(joined.status).toBe(409); expect(apiErrorSchema.parse(await joined.json()).error.code).toBe('ALREADY_IN_TEAM');
    expect((await request(0, '/teams', 'POST', { name: 'Another creation' })).status).toBe(409);
    expect(team.memberCount).toBe(1); expect(await counts()).toEqual({ teams: 2, members: 2, audit: 2 });
  });
});

describe('idempotency, failures and invite validation', () => {
  it('also wraps profile, registration and invite-preference mutations in the same replay contract', async () => {
    const profileKey = randomUUID();
    const edit = (displayName: string, key?: string) => fetch(`${server.url}/api/me`, {
      method: 'PATCH', headers: { Origin: origin, Cookie: cookies[0]!, 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) },
      body: JSON.stringify({ displayName }),
    });
    const original = await edit('First edit', profileKey); expect(original.status).toBe(200);
    const originalBody = await original.json(); expect((await edit('Later edit')).status).toBe(200);
    const replay = await edit('First edit', profileKey);
    expect(replay.headers.get('idempotent-replay')).toBe('true'); expect(await replay.json()).toEqual(originalBody);
    expect((await db.pool.query('SELECT display_name FROM users WHERE id=$1', [users[0]])).rows[0]?.display_name).toBe('Later edit');
    const registrationKey = randomUUID(); const preferenceKey = randomUUID();
    const registered = await request(0, '/register', 'POST', {}, registrationKey); expect(registered.status).toBe(200);
    const registrationBody = await registered.json();
    expect((await request(0, '/me', 'PATCH', { openToInvites: false }, preferenceKey)).status).toBe(200);
    const registrationReplay = await request(0, '/register', 'POST', {}, registrationKey);
    expect(registrationReplay.headers.get('idempotent-replay')).toBe('true'); expect(await registrationReplay.json()).toEqual(registrationBody);
    expect((await request(0, '/me', 'PATCH', { openToInvites: true })).status).toBe(200);
    expect((await request(0, '/me', 'PATCH', { openToInvites: false }, preferenceKey)).headers.get('idempotent-replay')).toBe('true');
    expect((await db.pool.query('SELECT open_to_invites FROM hackathon_participants WHERE hackathon_id=$1 AND user_id=$2', [hid, users[0]])).rows[0]?.open_to_invites).toBe(true);
  });
  it('replays twenty concurrent create requests with one membership/audit/publication', async () => {
    const key = randomUUID();
    const responses = await Promise.all(Array.from({ length: 20 }, () => request(0, '/teams', 'POST', { name: 'One intent' }, key)));
    expect(responses.every((r) => r.status === 201)).toBe(true);
    expect(responses.filter((r) => r.headers.get('idempotent-replay') === 'true')).toHaveLength(19);
    const bodies = await Promise.all(responses.map((r) => r.json()));
    for (const body of bodies) expect(body).toEqual(bodies[0]);
    expect(await counts()).toEqual({ teams: 1, members: 1, audit: 1 }); expect(changes).toHaveLength(1);
  });

  it('replays a recursively canonical body and rejects reuse for another body or route', async () => {
    const key = randomUUID();
    const team = await create(0, { name: 'Canonical', lookingFor: ['frontend'], description: 'Small team' }, key);
    const replay = await request(0, '/teams', 'POST', { description: 'Small team', lookingFor: ['frontend'], name: 'Canonical' }, key);
    expect(replay.headers.get('idempotent-replay')).toBe('true');
    expect((await replay.json() as CreateTeamResult).team).toEqual(team);
    expect((await request(0, '/teams', 'POST', { name: 'Changed' }, key)).status).toBe(422);
    expect((await request(0, `/teams/${team.id}/leave`, 'POST', {}, key)).status).toBe(422);
    expect(await counts()).toEqual({ teams: 1, members: 1, audit: 1 });
  });

  it('gives different users independent ownership of the same key and prevents keyless duplicate creation', async () => {
    const key = randomUUID(); await create(0, { name: 'Owner one' }, key); await create(1, { name: 'Owner two' }, key);
    const attempts = await Promise.all([request(2, '/teams', 'POST', { name: 'Keyless A' }), request(2, '/teams', 'POST', { name: 'Keyless B' })]);
    expect(attempts.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await counts()).toEqual({ teams: 3, members: 3, audit: 3 });
  });

  it('replays a committed join after code rotation without admitting a fresh stale-code intent', async () => {
    const team = await create(); const key = randomUUID();
    const original = await join(1, team.inviteCode!, key);
    await db.pool.query('UPDATE teams SET invite_code=$2 WHERE id=$1', [team.id, inviteCode()]);
    const replay = await request(1, '/teams/join-by-code', 'POST', { code: team.inviteCode }, key);
    expect(replay.status).toBe(200); expect(replay.headers.get('idempotent-replay')).toBe('true'); expect(await replay.json()).toEqual(original);
    expect((await request(1, '/teams/join-by-code', 'POST', { code: team.inviteCode }, randomUUID())).status).toBe(404);
    expect(changes).toHaveLength(2);
  });

  it('rolls back a full-team failure and re-evaluates the same key when a seat becomes free', async () => {
    await db.pool.query('UPDATE hackathons SET max_team_size=2 WHERE id=$1', [hid]);
    const team = await create(); await join(1, team.inviteCode!);
    const key = randomUUID(); const failed = await request(2, '/teams/join-by-code', 'POST', { code: team.inviteCode }, key);
    expect(failed.status).toBe(409); expect(apiErrorSchema.parse(await failed.json()).error.code).toBe('TEAM_FULL');
    expect((await db.pool.query('SELECT * FROM idempotency_keys WHERE user_id=$1 AND key=$2', [users[2], key])).rowCount).toBe(0);
    expect(await counts()).toEqual({ teams: 1, members: 2, audit: 2 });
    expect((await request(1, `/teams/${team.id}/leave`, 'POST')).status).toBe(200);
    expect((await join(2, team.inviteCode!, key)).alreadyMember).toBe(false);
  });

  it('rolls back the team, key, membership, cancellations and audit when a deferred constraint fails', async () => {
    const other = await create(1, { name: 'Existing' });
    await db.pool.query('INSERT INTO join_requests (hackathon_id,team_id,user_id) VALUES ($1,$2,$3)', [hid, other.id, users[0]]);
    await db.pool.query(`CREATE FUNCTION reject_test_creation() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'test commit failure' USING ERRCODE='23514'; END $$;
      CREATE CONSTRAINT TRIGGER reject_test_creation AFTER INSERT ON teams DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION reject_test_creation()`);
    const key = randomUUID();
    try {
      const response = await request(0, '/teams', 'POST', { name: 'Must roll back' }, key);
      expect(response.status).toBe(500);
      expect(await counts()).toEqual({ teams: 1, members: 1, audit: 1 });
      expect((await db.pool.query('SELECT * FROM idempotency_keys WHERE user_id=$1 AND key=$2', [users[0], key])).rowCount).toBe(0);
      expect((await db.pool.query('SELECT status FROM join_requests WHERE user_id=$1', [users[0]])).rows[0]?.status).toBe('pending');
      expect(changes).toHaveLength(1);
    } finally { await db.pool.query('DROP TRIGGER reject_test_creation ON teams; DROP FUNCTION reject_test_creation()'); }
    await create(0, { name: 'Must roll back' }, key);
  });

  it('returns the same error for unknown and expired codes', async () => {
    const team = await create();
    await db.pool.query("UPDATE teams SET invite_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [team.id]);
    const errors = [];
    for (const code of [inviteCode(), team.inviteCode]) {
      const response = await request(1, '/teams/join-by-code', 'POST', { code }); expect(response.status).toBe(404);
      const body = apiErrorSchema.parse(await response.json()); errors.push({ code: body.error.code, message: body.error.message });
    }
    expect(errors[0]).toEqual(errors[1]); expect(await counts()).toEqual({ teams: 1, members: 1, audit: 1 });
  });

  it('rejects a code that expires while the join waits for the team lock', async () => {
    const team = await create();
    await db.pool.query("UPDATE teams SET invite_expires_at=clock_timestamp()+interval '400 milliseconds' WHERE id=$1", [team.id]);
    const blocker = await db.pool.connect();
    let pending: Promise<Response> | undefined;
    try {
      await blocker.query('BEGIN');
      const { rows: [pid] } = await blocker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      await blocker.query('SELECT id FROM teams WHERE id=$1 FOR UPDATE', [team.id]);
      pending = request(1, '/teams/join-by-code', 'POST', { code: team.inviteCode }, randomUUID());
      const deadline = performance.now() + 1500;
      let blocked = false;
      while (performance.now() < deadline) {
        const { rows: [state] } = await db.pool.query(`SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))) AS blocked,
          (SELECT invite_expires_at > clock_timestamp() FROM teams WHERE id=$2) AS valid`, [pid!.pid, team.id]);
        if (state.blocked) { expect(state.valid).toBe(true); blocked = true; break; }
        await pause(5);
      }
      expect(blocked).toBe(true);
      // Poll the database clock until expiry is observed, rather than assuming a sleep proves it.
      while ((await db.pool.query('SELECT invite_expires_at > clock_timestamp() AS valid FROM teams WHERE id=$1', [team.id])).rows[0]?.valid) {
        if (performance.now() >= deadline) throw new Error('Database clock failed to reach invite expiry.');
        await pause(5);
      }
      await blocker.query('COMMIT');
      const response = await pending; expect(response.status).toBe(404); expect(apiErrorSchema.parse(await response.json()).error.code).toBe('INVALID_OR_EXPIRED_CODE');
    } finally { await blocker.query('ROLLBACK'); blocker.release(); await pending; }
    expect(await counts()).toEqual({ teams: 1, members: 1, audit: 1 });
  });

  it('limits failed codes per user while refunding successful joins and ignoring forged proxy headers', async () => {
    const team = await create();
    for (let i = 0; i < 9; i++) expect((await request(1, '/teams/join-by-code', 'POST', { code: inviteCode() })).status).toBe(404);
    for (let i = 0; i < 12; i++) await join(1, team.inviteCode!);
    expect((await request(1, '/teams/join-by-code', 'POST', { code: inviteCode() })).status).toBe(404);
    const limited = await request(1, '/teams/join-by-code', 'POST', { code: inviteCode() }, undefined, { 'X-Forwarded-For': '192.0.2.9' });
    expect(limited.status).toBe(429); expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
    expect((await request(2, '/teams/join-by-code', 'POST', { code: inviteCode() })).status).toBe(404);
  });

  it('caps failed codes at 40 per IP across users and forged forwarded addresses', async () => {
    for (let i = 0; i < 40; i++) expect((await request(Math.floor(i / 10), '/teams/join-by-code', 'POST', { code: inviteCode() }, undefined, { 'X-Forwarded-For': `192.0.2.${i + 1}` })).status).toBe(404);
    expect((await request(4, '/teams/join-by-code', 'POST', { code: inviteCode() })).status).toBe(429);
  });
});
