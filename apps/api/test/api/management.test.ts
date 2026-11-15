import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuditEntry, CreateTeamResult, InboxRequest, InviteResult, Page, RequestResult } from '@teamforge/shared';
import { raceFixture, outcome } from '../helpers/raceFixture.js';
import type { RaceFixture, RaceResponse } from '../helpers/raceFixture.js';
import { fireAtOnce } from '../helpers/concurrency.js';
import * as invite from '../../src/modules/teams/invite.js';

describe('applications, leader controls and audit HTTP behavior', () => {
  let f: RaceFixture;
  beforeEach(async () => { f = await raceFixture(9); });
  afterEach(async () => {
    vi.restoreAllMocks();
    try { await f.idle(); await f.invariantReport(); }
    finally { await f.dispose(); }
  });
  const get = <T = unknown>(actor: number, path: string) => f.call<T>(actor, path, {}, null, 'GET');
  const apply = (actor: number, teamId: string, message = 'I can help with design.') => f.call<RequestResult>(actor, `/teams/${teamId}/requests`, { message });
  const decide = (actor: number, id: string, action = 'accept', key = randomUUID()) => f.call<RequestResult>(actor, `/requests/${id}/${action}`, {}, key);
  async function application(actor: number, teamId: string) {
    const result = await apply(actor, teamId);
    expect(outcome(result)).toBe('201'); return result.body.request;
  }
  async function snapshot() {
    return (await f.pool.query(`SELECT jsonb_build_object(
      'teams',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM teams t),
      'members',(SELECT jsonb_agg(to_jsonb(m) ORDER BY team_id,user_id) FROM team_members m),
      'requests',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM join_requests r),
      'audit',(SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM audit_log a),
      'keys',(SELECT jsonb_agg(to_jsonb(k) ORDER BY user_id,key) FROM idempotency_keys k)) AS state`)).rows[0]!.state;
  }
  async function actions(teamId: string) {
    return (await f.pool.query<{ action: string; actor_id: string; target_user_id: string | null; details: Record<string, unknown> }>(
      'SELECT action,actor_id,target_user_id,details FROM audit_log WHERE team_id=$1 ORDER BY id', [teamId])).rows;
  }

  it('creates a pending application with trimmed text, actor audit and no membership', async () => {
    const team = await f.create(0); f.published.length = 0;
    const result = await apply(2, team.id, '  Design systems  ');
    expect(result.status).toBe(201);
    expect(result.body.request).toMatchObject({ teamId: team.id, userId: f.actors[2]!.id, message: 'Design systems', status: 'pending', decidedAt: null, decidedBy: null });
    expect((await f.pool.query('SELECT user_id FROM team_members WHERE user_id=$1', [f.actors[2]!.id])).rowCount).toBe(0);
    expect((await actions(team.id)).at(-1)).toMatchObject({ action: 'request.created', actor_id: f.actors[2]!.id, target_user_id: f.actors[2]!.id });
    expect(f.published).toHaveLength(1);
  });
  it('returns the existing pending application without overwriting its text or duplicating effects', async () => {
    const team = await f.create(0); const first = await application(2, team.id); f.published.length = 0;
    const duplicate = await apply(2, team.id, 'Changed text');
    expect(duplicate.status).toBe(200); expect(duplicate.body.request).toEqual(first);
    expect((await actions(team.id)).filter((a) => a.action === 'request.created')).toHaveLength(1);
    expect(f.published).toHaveLength(0);
  });
  it('enforces five pending requests and returns a duplicate before checking that cap', async () => {
    const teams = [];
    for (let actor = 0; actor < 6; actor++) teams.push(await f.create(actor));
    for (const team of teams.slice(0, 5)) await application(8, team.id);
    expect(outcome(await apply(8, teams[0]!.id))).toBe('200');
    expect(outcome(await apply(8, teams[5]!.id))).toBe('409:TOO_MANY_PENDING');
    expect((await f.pool.query("SELECT id FROM join_requests WHERE user_id=$1 AND status='pending'", [f.actors[8]!.id])).rowCount).toBe(5);
  });
  it('serializes six concurrent applications so the pending cap cannot be exceeded', async () => {
    const teams = [];
    for (let actor = 0; actor < 6; actor++) teams.push(await f.create(actor));
    const results = await fireAtOnce(teams.map((team) => () => apply(8, team.id)));
    expect(results.map(outcome).sort()).toEqual([...Array<string>(5).fill('201'), '409:TOO_MANY_PENDING']);
  });
  it('rejects applications to closed teams', async () => {
    const team = await f.create(0);
    expect(outcome(await f.call(0, `/teams/${team.id}`, { isOpen: false }, randomUUID(), 'PATCH'))).toBe('200');
    const before = await snapshot(); expect(outcome(await apply(2, team.id))).toBe('409:TEAM_CLOSED'); expect(await snapshot()).toEqual(before);
  });
  it('rejects applications to full teams', async () => {
    const team = await f.team([0, 1, 2, 3]); const before = await snapshot();
    expect(outcome(await apply(4, team.id))).toBe('409:TEAM_FULL'); expect(await snapshot()).toEqual(before);
  });
  it('rejects applications from a person already on a team', async () => {
    const first = await f.create(0); await f.create(2);
    expect(outcome(await apply(2, first.id))).toBe('409:ALREADY_IN_TEAM');
  });
  it('accepts atomically and cancels other pending requests with the deciding leader as actor', async () => {
    const team = await f.create(0); const other = await f.create(1);
    const request = await application(2, team.id); const cancelled = await application(2, other.id);
    f.published.length = 0;
    const result = await decide(0, request.id);
    expect(outcome(result)).toBe('200');
    expect(result.body.request).toMatchObject({ status: 'accepted', decidedBy: f.actors[0]!.id });
    expect(result.body.request.decidedAt).not.toBeNull();
    expect((await f.pool.query('SELECT team_id FROM team_members WHERE user_id=$1', [f.actors[2]!.id])).rows).toEqual([{ team_id: team.id }]);
    expect((await f.pool.query('SELECT status,decided_by FROM join_requests WHERE id=$1', [cancelled.id])).rows).toEqual([{ status: 'cancelled', decided_by: f.actors[0]!.id }]);
    expect((await actions(other.id)).at(-1)).toMatchObject({ action: 'request.cancelled', actor_id: f.actors[0]!.id, target_user_id: f.actors[2]!.id });
    expect((await actions(team.id)).slice(-2).map((a) => a.action)).toEqual(['request.accepted', 'member.joined']);
    expect(f.published).toHaveLength(1);
  });
  it('leaves a full-team accept unchanged and permits the same key after a seat reopens', async () => {
    const team = await f.team([0, 1, 2]); const request = await application(3, team.id);
    expect((await f.join(4, team.inviteCode!)).status).toBe(200);
    const key = randomUUID(); const before = await snapshot(); f.published.length = 0;
    expect(outcome(await decide(0, request.id, 'accept', key))).toBe('409:TEAM_FULL');
    expect(await snapshot()).toEqual(before); expect(f.published).toHaveLength(0);
    expect(outcome(await f.call(4, `/teams/${team.id}/leave`, {}))).toBe('200');
    expect(outcome(await decide(0, request.id, 'accept', key))).toBe('200');
  });
  it('permits approval of an existing application after the team closes to new applicants', async () => {
    const team = await f.create(0); const request = await application(2, team.id);
    await f.call(0, `/teams/${team.id}`, { isOpen: false }, randomUUID(), 'PATCH');
    expect(outcome(await decide(0, request.id))).toBe('200');
  });
  it('rejects accepting a request cancelled by joining another team without changing its history', async () => {
    const team = await f.create(0); const other = await f.create(1); const request = await application(2, team.id);
    await f.join(2, other.inviteCode!); const before = await snapshot();
    expect(outcome(await decide(0, request.id))).toBe('409:REQUEST_NOT_PENDING'); expect(await snapshot()).toEqual(before);
  });
  it('declines once, audits the decision, and allows a fresh application', async () => {
    const team = await f.create(0); const request = await application(2, team.id);
    const result = await decide(0, request.id, 'decline');
    expect(outcome(result)).toBe('200'); expect(result.body.request.status).toBe('declined');
    expect((await actions(team.id)).at(-1)).toMatchObject({ action: 'request.declined', actor_id: f.actors[0]!.id, target_user_id: f.actors[2]!.id });
    const before = await snapshot(); expect(outcome(await decide(0, request.id, 'decline'))).toBe('409:REQUEST_NOT_PENDING'); expect(await snapshot()).toEqual(before);
    expect((await application(2, team.id)).id).not.toBe(request.id);
  });
  it('allows only the applicant to withdraw and audits that cancellation once', async () => {
    const team = await f.create(0); const request = await application(2, team.id);
    expect(outcome(await f.call(0, `/requests/${request.id}`, {}, randomUUID(), 'DELETE'))).toBe('404:NOT_FOUND');
    const result = await f.call<RequestResult>(2, `/requests/${request.id}`, {}, randomUUID(), 'DELETE');
    expect(outcome(result)).toBe('200'); expect(result.body.request.status).toBe('cancelled');
    expect((await actions(team.id)).at(-1)).toMatchObject({ action: 'request.cancelled', actor_id: f.actors[2]!.id, target_user_id: f.actors[2]!.id, details: { reason: 'withdrawn' } });
    expect(outcome(await f.call(2, `/requests/${request.id}`, {}, randomUUID(), 'DELETE'))).toBe('409:REQUEST_NOT_PENDING');
    expect((await application(2, team.id)).id).not.toBe(request.id);
  });
  it('does not let an applicant withdraw an accepted request', async () => {
    const team = await f.create(0); const request = await application(2, team.id); await decide(0, request.id);
    const before = await snapshot(); expect(outcome(await f.call(2, `/requests/${request.id}`, {}, randomUUID(), 'DELETE'))).toBe('409:REQUEST_NOT_PENDING'); expect(await snapshot()).toEqual(before);
  });
  it('paginates a leader inbox without losing microsecond timestamps or leaking identity secrets', async () => {
    const team = await f.create(0);
    for (const actor of [2, 3, 4, 5]) await application(actor, team.id);
    await f.pool.query("UPDATE join_requests SET created_at='2026-01-01T00:00:00.123456Z' WHERE team_id=$1", [team.id]);
    await f.pool.query("UPDATE join_requests SET created_at='2026-01-01T00:00:00.123789Z' WHERE team_id=$1 AND user_id=$2", [team.id, f.actors[2]!.id]);
    const ids: string[] = []; let cursor: string | null = null;
    do {
      const response: RaceResponse<Page<InboxRequest>> = await get<Page<InboxRequest>>(0, `/teams/${team.id}/requests?limit=1${cursor ? `&cursor=${cursor}` : ''}`);
      expect(outcome(response)).toBe('200');
      expect(JSON.stringify(response.body)).not.toMatch(/email|password|inviteCode|not-a-login-credential/);
      expect(response.body.items[0]!.applicant).toMatchObject({ displayName: 'Test participant', skills: [], utcOffsetMin: 0 });
      ids.push(...response.body.items.map((item) => item.id)); cursor = response.body.nextCursor;
      expect(ids.length).toBeLessThanOrEqual(4);
    } while (cursor);
    expect(ids).toEqual((await f.pool.query<{ id: string }>('SELECT id FROM join_requests WHERE team_id=$1 ORDER BY created_at DESC,id DESC', [team.id])).rows.map((r) => r.id));
  });
  it('returns only pending requests in the inbox and own pending list', async () => {
    const team = await f.create(0); const first = await application(2, team.id); const pending = await application(3, team.id);
    await decide(0, first.id, 'decline');
    expect((await get<Page<InboxRequest>>(0, `/teams/${team.id}/requests`)).body.items.map((r) => r.id)).toEqual([pending.id]);
    const own = await get<{ pendingRequests: { id: string }[] }>(3, '/me/team');
    expect(own.body.pendingRequests.map((r) => r.id)).toEqual([pending.id]);
  });
  it('updates only allowed fields and preserves capacity and membership', async () => {
    const team = await f.team([0, 1]);
    const response = await f.call<CreateTeamResult>(0, `/teams/${team.id}`, { name: '  Better team  ', description: 'Build together', lookingFor: ['design'], isOpen: false }, randomUUID(), 'PATCH');
    expect(outcome(response)).toBe('200');
    expect(response.body.team).toMatchObject({ name: 'Better team', description: 'Build together', lookingFor: ['design'], isOpen: false, maxSize: 4, memberCount: 2 });
    expect((await actions(team.id)).at(-1)).toMatchObject({ action: 'team.updated', details: { changed: ['description', 'isOpen', 'lookingFor', 'name'] } });
  });
  it('rejects duplicate team names and rolls back edit audit/key', async () => {
    await f.create(0, 'Reserved name'); const team = await f.create(1); const before = await snapshot();
    expect(outcome(await f.call(1, `/teams/${team.id}`, { name: 'reserved NAME' }, randomUUID(), 'PATCH'))).toBe('409:TEAM_NAME_TAKEN'); expect(await snapshot()).toEqual(before);
  });
  it('rotates the code and expiry, invalidating the old code while preserving the new one', async () => {
    const team = await f.create(0);
    await f.pool.query("UPDATE teams SET invite_expires_at=clock_timestamp()-interval '1 hour' WHERE id=$1", [team.id]);
    const response = await f.call<InviteResult>(0, `/teams/${team.id}/invite`, {});
    expect(outcome(response)).toBe('200'); expect(response.body.inviteCode).not.toBe(team.inviteCode);
    expect((await get<InviteResult>(0, `/teams/${team.id}/invite`)).body).toEqual(response.body);
    expect((await f.pool.query("SELECT invite_expires_at>clock_timestamp()+interval '47 hours' AS fresh FROM teams WHERE id=$1", [team.id])).rows[0]!.fresh).toBe(true);
    expect(outcome(await f.join(2, team.inviteCode!))).toBe('404:INVALID_OR_EXPIRED_CODE');
    expect(outcome(await f.join(2, response.body.inviteCode))).toBe('200');
  });
  it('skips taken invite proposals and never reuses the current code on rotation', async () => {
    const team = await f.create(0); const other = await f.create(1);
    const generator = vi.spyOn(invite, 'inviteCode').mockReturnValueOnce(other.inviteCode!).mockReturnValueOnce(team.inviteCode!).mockReturnValue('0123456789');
    const result = await f.call<InviteResult>(0, `/teams/${team.id}/invite`, {});
    expect(outcome(result)).toBe('200'); expect(result.body.inviteCode).toBe('0123456789'); expect(generator).toHaveBeenCalledTimes(3);
  });
  it('removes a member and rotates their old invite atomically', async () => {
    const team = await f.team([0, 1]); f.published.length = 0;
    expect(outcome(await f.call(0, `/teams/${team.id}/members/${f.actors[1]!.id}`, {}, randomUUID(), 'DELETE'))).toBe('200');
    expect(outcome(await f.join(1, team.inviteCode!))).toBe('404:INVALID_OR_EXPIRED_CODE');
    expect((await actions(team.id)).slice(-2).map((a) => a.action)).toEqual(['member.removed', 'invite.rotated']);
    expect((await actions(team.id)).at(-1)!.details).toEqual({ reason: 'member_removed' });
    expect(f.published).toHaveLength(1);
    expect(outcome(await get(1, `/teams/${team.id}/audit`))).toBe('404:NOT_A_MEMBER');
    expect(outcome(await apply(1, team.id))).toBe('201');
  });
  it('rejects leader self-removal and removing a nonmember without rotating', async () => {
    const team = await f.create(0); const before = await snapshot();
    expect(outcome(await f.call(0, `/teams/${team.id}/members/${f.actors[0]!.id}`, {}, randomUUID(), 'DELETE'))).toBe('409:CANNOT_REMOVE_LEADER');
    expect(outcome(await f.call(0, `/teams/${team.id}/members/${f.actors[2]!.id}`, {}, randomUUID(), 'DELETE'))).toBe('404:NOT_A_MEMBER');
    expect(await snapshot()).toEqual(before);
  });
  it('rolls removal back completely if no fresh invite code can be allocated', async () => {
    const team = await f.team([0, 1]); const before = await snapshot(); f.published.length = 0;
    const generator = vi.spyOn(invite, 'inviteCode').mockReturnValue(team.inviteCode!);
    expect(outcome(await f.call(0, `/teams/${team.id}/members/${f.actors[1]!.id}`, {}, randomUUID(), 'DELETE'))).toBe('503:BUSY');
    expect(generator).toHaveBeenCalledTimes(5); expect(await snapshot()).toEqual(before); expect(f.published).toHaveLength(0);
  });
  it('paginates member audit by exact bigint id, newest first, with correlation and without invites', async () => {
    const team = await f.team([0, 1]);
    await f.pool.query("SELECT setval('audit_log_id_seq',9007199254740992)");
    await f.call(0, `/teams/${team.id}/invite`, {});
    const first = await get<Page<AuditEntry>>(1, `/teams/${team.id}/audit?limit=1`);
    expect(outcome(first)).toBe('200'); expect(first.body.items[0]!.id).toBe('9007199254740993');
    expect(first.body.items[0]!.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.stringify(first.body)).not.toContain(team.inviteCode!);
    const next = await get<Page<AuditEntry>>(1, `/teams/${team.id}/audit?limit=1&cursor=${first.body.nextCursor}`);
    expect(next.body.items[0]!.action).toBe('member.joined');
    expect((await get<Page<AuditEntry>>(0, `/teams/${team.id}/audit`)).body.items).toHaveLength(3);
  });
  it('preserves history after deletion while denying its API to all former members and outsiders', async () => {
    const team = await f.team([0, 1]); await f.call(1, `/teams/${team.id}/leave`, {}); await f.call(0, `/teams/${team.id}/leave`, {});
    expect((await actions(team.id)).map((a) => a.action)).toContain('team.deleted');
    for (const actor of [0, 1, 2]) expect(outcome(await get(actor, `/teams/${team.id}/audit`))).toBe('404:TEAM_NOT_FOUND');
  });
  it('authorizes the new leader and immediately rejects the former leader after transfer', async () => {
    const team = await f.team([0, 1]); const request = await application(2, team.id); await f.call(0, `/teams/${team.id}/leave`, {});
    for (const suffix of ['invite', 'requests']) {
      expect(outcome(await get(0, `/teams/${team.id}/${suffix}`))).toBe('403:NOT_LEADER');
      expect(outcome(await get(1, `/teams/${team.id}/${suffix}`))).toBe('200');
    }
    expect(outcome(await decide(0, request.id))).toBe('403:NOT_LEADER'); expect(outcome(await decide(1, request.id))).toBe('200');
  });
  it('enforces the full leader-control authorization matrix on every endpoint', async () => {
    const team = await f.team([0, 1]); await f.create(3); const request = await application(2, team.id);
    await f.pool.query('DELETE FROM hackathon_participants WHERE hackathon_id=$1 AND user_id=$2', [f.hackathonId, f.actors[8]!.id]);
    const endpoints: Array<[string, string, unknown]> = [
      ['GET', `/teams/${team.id}/invite`, {}], ['GET', `/teams/${team.id}/requests`, {}],
      ['PATCH', `/teams/${team.id}`, { name: 'Unauthorized' }], ['POST', `/teams/${team.id}/invite`, {}],
      ['DELETE', `/teams/${team.id}/members/${f.actors[1]!.id}`, {}],
      ['POST', `/requests/${request.id}/accept`, {}], ['POST', `/requests/${request.id}/decline`, {}],
    ];
    const before = await snapshot();
    for (const [method, path, body] of endpoints) {
      for (const actor of [1, 2, 3, 4]) expect(outcome(await f.call(actor, path, body, randomUUID(), method))).toBe('403:NOT_LEADER');
      expect(outcome(await f.call(8, path, body, randomUUID(), method))).toBe('403:NOT_REGISTERED');
      const cookie = f.actors[7]!.cookie; f.actors[7]!.cookie = '';
      try { expect(outcome(await f.call(7, path, body, randomUUID(), method))).toBe('401:UNAUTHENTICATED'); }
      finally { f.actors[7]!.cookie = cookie; }
    }
    expect(outcome(await get(4, `/teams/${team.id}/audit`))).toBe('404:NOT_A_MEMBER'); expect(await snapshot()).toEqual(before);
  });
  it('requires authentication and registration for application, withdrawal and audit reads', async () => {
    const team = await f.create(0); const request = await application(2, team.id);
    await f.pool.query('DELETE FROM hackathon_participants WHERE hackathon_id=$1 AND user_id=$2', [f.hackathonId, f.actors[8]!.id]);
    for (const [method, path] of [['POST', `/teams/${team.id}/requests`], ['DELETE', `/requests/${request.id}`], ['GET', `/teams/${team.id}/audit`]]) {
      expect(outcome(await f.call(8, path!, {}, randomUUID(), method!))).toBe('403:NOT_REGISTERED');
      f.actors[7]!.cookie = '';
      expect(outcome(await f.call(7, path!, {}, randomUUID(), method!))).toBe('401:UNAUTHENTICATED');
    }
  });
  it('scopes every new endpoint to its hackathon even when the actor is registered in both', async () => {
    const otherId = randomUUID();
    await f.pool.query("INSERT INTO hackathons (id,name,min_team_size,max_team_size) VALUES ($1,'Other',2,4)", [otherId]);
    await f.pool.query('INSERT INTO hackathon_participants (hackathon_id,user_id) SELECT $1,id FROM users', [otherId]);
    const team = (await f.call<CreateTeamResult>(0, '/teams', { name: 'Other team' }, randomUUID(), 'POST', otherId)).body.team;
    const request = (await f.call<RequestResult>(2, `/teams/${team.id}/requests`, {}, randomUUID(), 'POST', otherId)).body.request;
    const before = await snapshot();
    const paths: Array<[string, string, unknown]> = [
      ['GET', `/teams/${team.id}/invite`, {}], ['GET', `/teams/${team.id}/requests`, {}], ['GET', `/teams/${team.id}/audit`, {}],
      ['POST', `/teams/${team.id}/requests`, {}], ['PATCH', `/teams/${team.id}`, { isOpen: false }], ['POST', `/teams/${team.id}/invite`, {}],
      ['DELETE', `/teams/${team.id}/members/${f.actors[1]!.id}`, {}],
      ['POST', `/requests/${request.id}/accept`, {}], ['POST', `/requests/${request.id}/decline`, {}], ['DELETE', `/requests/${request.id}`, {}],
    ];
    for (const [method, path, body] of paths) {
      // Exercise withdrawal as its actual owner so ownership cannot mask a
      // missing hackathon predicate.
      const actor = method === 'DELETE' && path.startsWith('/requests/') ? 2 : 0;
      const response = await f.call(actor, path, body, randomUUID(), method);
      expect(outcome(response)).toBe(path.startsWith('/requests/') ? '404:NOT_FOUND' : '404:TEAM_NOT_FOUND');
      expect(JSON.stringify(response.body)).not.toContain('Other team');
    }
    expect(await snapshot()).toEqual(before);
  });
  it('rejects malformed fields, escalation fields, params, queries and cursors', async () => {
    const team = await f.create(0);
    for (const body of [{}, { maxSize: 9 }, { leaderId: f.actors[1]!.id }, { lookingFor: ['unknown'] }, { lookingFor: ['design', 'design'] }, { name: 'Bad\u0000name' }]) {
      expect(outcome(await f.call(0, `/teams/${team.id}`, body, randomUUID(), 'PATCH'))).toBe('400:VALIDATION_ERROR');
    }
    for (const body of [{ message: 'x'.repeat(301) }, { status: 'accepted' }, { message: '\u0000' }]) expect(outcome(await f.call(2, `/teams/${team.id}/requests`, body))).toBe('400:VALIDATION_ERROR');
    for (const suffix of ['requests', 'audit']) {
      for (const query of ['limit=0', 'limit=51', 'limit=1&limit=2', 'cursor=garbage', 'unknown=1', 'cursor=' + Buffer.from('{"id":"9223372036854775808"}').toString('base64url')]) {
        expect(outcome(await get(0, `/teams/${team.id}/${suffix}?${query}`))).toBe('400:VALIDATION_ERROR');
      }
    }
    expect(outcome(await f.call(0, '/requests/not-a-uuid/accept', {}))).toBe('400:VALIDATION_ERROR');
    expect(outcome(await get(0, '/me/team?unknown=1'))).toBe('400:VALIDATION_ERROR');
    const invalidYear = Buffer.from(JSON.stringify({ createdAt: '0000-01-01T00:00:00.000000Z', id: randomUUID() })).toString('base64url');
    expect(outcome(await get(0, `/teams/${team.id}/requests?cursor=${invalidYear}`))).toBe('400:VALIDATION_ERROR');
  });
  it('normalizes UUID parameters before membership and leader self-removal comparisons', async () => {
    const team = await f.create(0); const request = await application(2, team.id);
    expect(outcome(await f.call(0, `/teams/${team.id.toUpperCase()}/audit`, {}, null, 'GET', f.hackathonId.toUpperCase()))).toBe('200');
    expect(outcome(await get(0, `/teams/${team.id.toUpperCase()}/invite`))).toBe('200');
    expect(outcome(await f.call(0, `/teams/${team.id}/members/${f.actors[0]!.id.toUpperCase()}`, {}, randomUUID(), 'DELETE'))).toBe('409:CANNOT_REMOVE_LEADER');
    expect(outcome(await decide(0, request.id.toUpperCase()))).toBe('200');
  });
  it('enforces 20 applications per user per minute, including duplicate attempts', async () => {
    const team = await f.create(0);
    for (let i = 0; i < 20; i++) expect(outcome(await apply(2, team.id))).toBe(i === 0 ? '201' : '200');
    const limited = await apply(2, team.id);
    expect(outcome(limited)).toBe('429:RATE_LIMITED'); expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    expect(outcome(await apply(3, team.id))).toBe('201');
  });
  it('rolls an accept, its request transition, audit and key back on deferred commit failure', async () => {
    const team = await f.create(0); const request = await application(2, team.id); const before = await snapshot(); f.published.length = 0;
    await f.pool.query(`CREATE FUNCTION reject_test_accept() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      RAISE EXCEPTION 'injected commit failure' USING ERRCODE='23514'; END $$;
      CREATE CONSTRAINT TRIGGER reject_test_accept AFTER INSERT ON team_members DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION reject_test_accept()`);
    expect(outcome(await decide(0, request.id))).toBe('500:INTERNAL'); expect(await snapshot()).toEqual(before); expect(f.published).toHaveLength(0);
  });
  for (const action of ['apply', 'accept', 'decline', 'withdraw', 'edit', 'rotate', 'remove']) {
    it(`replays an identical ${action} intent without another effect, audit or publication`, async () => {
      const team = await f.team([0, 1]);
      const request = action === 'accept' || action === 'decline' || action === 'withdraw' ? await application(2, team.id) : null;
      const key = randomUUID();
      const routes: Record<string, [number, string, string, unknown]> = {
        apply: [2, 'POST', `/teams/${team.id}/requests`, {}], accept: [0, 'POST', `/requests/${request?.id}/accept`, {}],
        decline: [0, 'POST', `/requests/${request?.id}/decline`, {}], withdraw: [2, 'DELETE', `/requests/${request?.id}`, {}],
        edit: [0, 'PATCH', `/teams/${team.id}`, { description: 'Updated' }], rotate: [0, 'POST', `/teams/${team.id}/invite`, {}],
        remove: [0, 'DELETE', `/teams/${team.id}/members/${f.actors[1]!.id}`, {}],
      };
      const [actor, method, path, body] = routes[action]!;
      const first = await f.call(actor, path, body, key, method); expect(first.status).toBe(action === 'apply' ? 201 : 200);
      const committed = await snapshot(); f.published.length = 0;
      const replay = await f.call(actor, path, body, key, method);
      expect(replay.status).toBe(first.status); expect(replay.body).toEqual(first.body); expect(replay.headers['idempotent-replay']).toBe('true');
      expect(await snapshot()).toEqual(committed); expect(f.published).toHaveLength(0);
    });
  }
});
