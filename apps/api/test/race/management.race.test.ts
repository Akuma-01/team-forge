import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { RequestResult } from '@teamforge/shared';
import { raceFixture, outcome } from '../helpers/raceFixture.js';
import type { RaceFixture } from '../helpers/raceFixture.js';
import { fireAtOnce } from '../helpers/concurrency.js';
import { cancellationWrite, decisionWrite, orderedRace, participantLock, teamLock } from '../helpers/orderedRace.js';

describe('request and leader operations under conflicting transactions', () => {
  let f: RaceFixture | undefined;
  afterEach(async () => {
    if (!f) return;
    try { await f.idle(); await f.invariantReport(); }
    finally { await f.dispose(); f = undefined; }
  });
  async function apply(actor: number, teamId: string) {
    const response = await f!.call<RequestResult>(actor, `/teams/${teamId}/requests`, { message: 'Ready to help.' });
    expect(outcome(response)).toBe('201'); return response.body.request.id;
  }
  const decide = (actor: number, requestId: string, key: string, action = 'accept') => f!.call(actor, `/requests/${requestId}/${action}`, {}, key);
  async function requestState(id: string) { return (await f!.pool.query('SELECT status,decided_by FROM join_requests WHERE id=$1', [id])).rows[0]; }
  async function memberIds(teamId: string) { return (await f!.pool.query<{ user_id: string }>('SELECT user_id FROM team_members WHERE team_id=$1 ORDER BY user_id', [teamId])).rows.map((r) => r.user_id); }
  async function auditActions(teamId: string) { return (await f!.pool.query<{ action: string }>('SELECT action FROM audit_log WHERE team_id=$1 ORDER BY id', [teamId])).rows.map((r) => r.action); }
  async function keysFor(keys: string[]) { return (await f!.pool.query('SELECT key FROM idempotency_keys WHERE key=ANY($1::text[])', [keys])).rowCount; }

  for (const acceptFirst of [true, false]) {
    it(`accept versus code for the last seat: ${acceptFirst ? 'accept' : 'code'} locks first`, async () => {
      const race = orderedRace(); const fixture = f = await raceFixture(5, { observe: race.observe });
      const team = await fixture.team([0, 1, 2]); const requestId = await apply(3, team.id); fixture.published.length = 0;
      const accept = (key: string) => decide(0, requestId, key);
      const join = (key: string) => fixture.join(4, team.inviteCode!, key);
      const results = await race.run(fixture, acceptFirst ? accept : join, acceptFirst ? join : accept);
      expect(results.map(outcome)).toEqual(['200', '409:TEAM_FULL']);
      expect(await memberIds(team.id)).toEqual([0, 1, 2, acceptFirst ? 3 : 4].map((i) => fixture.actors[i]!.id).sort());
      expect(await requestState(requestId)).toEqual({ status: acceptFirst ? 'accepted' : 'pending', decided_by: acceptFirst ? fixture.actors[0]!.id : null });
      expect(await auditActions(team.id)).toEqual(['team.created', 'member.joined', 'member.joined', 'request.created', ...(acceptFirst ? ['request.accepted'] : []), 'member.joined']);
      expect(fixture.published).toHaveLength(1);
    });
  }
  for (const firstLeader of [0, 1]) {
    it(`two teams accept one applicant: leader ${firstLeader} locks the applicant first`, async () => {
      const race = orderedRace(teamLock, participantLock); const fixture = f = await raceFixture(3, { observe: race.observe });
      const teams = [await fixture.create(0), await fixture.create(1)];
      const requests = [await apply(2, teams[0]!.id), await apply(2, teams[1]!.id)]; fixture.published.length = 0;
      const results = await race.run(fixture, (key) => decide(firstLeader, requests[firstLeader]!, key), (key) => decide(1 - firstLeader, requests[1 - firstLeader]!, key));
      expect(results.map(outcome)).toEqual(['200', '409:REQUEST_NOT_PENDING']);
      expect((await fixture.pool.query('SELECT team_id FROM team_members WHERE user_id=$1', [fixture.actors[2]!.id])).rows).toEqual([{ team_id: teams[firstLeader]!.id }]);
      expect(await requestState(requests[firstLeader]!)).toEqual({ status: 'accepted', decided_by: fixture.actors[firstLeader]!.id });
      expect(await requestState(requests[1 - firstLeader]!)).toEqual({ status: 'cancelled', decided_by: fixture.actors[firstLeader]!.id });
      expect(await auditActions(teams[1 - firstLeader]!.id)).toEqual(['team.created', 'request.created', 'request.cancelled']);
      expect(fixture.published).toHaveLength(1);
    });
  }
  for (const removeFirst of [true, false]) {
    it(`removal versus member leave: ${removeFirst ? 'removal' : 'leave'} locks the member first`, async () => {
      const race = orderedRace(teamLock, participantLock); const fixture = f = await raceFixture(2, { observe: race.observe });
      const team = await fixture.team([0, 1]); fixture.published.length = 0;
      const remove = (key: string) => fixture.call(0, `/teams/${team.id}/members/${fixture.actors[1]!.id}`, {}, key, 'DELETE');
      const leave = (key: string) => fixture.call(1, `/teams/${team.id}/leave`, {}, key);
      const results = await race.run(fixture, removeFirst ? remove : leave, removeFirst ? leave : remove);
      expect(results.map(outcome)).toEqual(['200', '404:NOT_A_MEMBER']);
      expect(await memberIds(team.id)).toEqual([fixture.actors[0]!.id]);
      expect(await auditActions(team.id)).toEqual(['team.created', 'member.joined', ...(removeFirst ? ['member.removed', 'invite.rotated'] : ['member.left'])]);
      const currentCode = (await fixture.pool.query('SELECT invite_code FROM teams WHERE id=$1', [team.id])).rows[0]!.invite_code;
      expect(currentCode === team.inviteCode).toBe(!removeFirst); expect(fixture.published).toHaveLength(1);
    });
  }
  for (const rotateFirst of [true, false]) {
    it(`rotation versus code join: ${rotateFirst ? 'rotation' : 'join'} locks the team first`, async () => {
      const race = orderedRace(); const fixture = f = await raceFixture(2, { observe: race.observe });
      const team = await fixture.create(0); fixture.published.length = 0;
      const rotate = (key: string) => fixture.call(0, `/teams/${team.id}/invite`, {}, key);
      const join = (key: string) => fixture.join(1, team.inviteCode!, key);
      const results = await race.run(fixture, rotateFirst ? rotate : join, rotateFirst ? join : rotate);
      expect(results.map(outcome)).toEqual(rotateFirst ? ['200', '404:INVALID_OR_EXPIRED_CODE'] : ['200', '200']);
      expect(await memberIds(team.id)).toEqual((rotateFirst ? [0] : [0, 1]).map((i) => fixture.actors[i]!.id).sort());
      expect(await auditActions(team.id)).toEqual(['team.created', ...(rotateFirst ? [] : ['member.joined']), 'invite.rotated']);
      expect(fixture.published).toHaveLength(rotateFirst ? 1 : 2);
    });
  }
  for (const leaveFirst of [true, false]) {
    it(`old leader acceptance versus leadership transfer: ${leaveFirst ? 'leave' : 'accept'} locks first`, async () => {
      const race = orderedRace(); const fixture = f = await raceFixture(3, { observe: race.observe });
      const team = await fixture.team([0, 1]); const requestId = await apply(2, team.id); fixture.published.length = 0;
      const leave = (key: string) => fixture.call(0, `/teams/${team.id}/leave`, {}, key);
      const accept = (key: string) => decide(0, requestId, key);
      const results = await race.run(fixture, leaveFirst ? leave : accept, leaveFirst ? accept : leave);
      expect(results.map(outcome)).toEqual(leaveFirst ? ['200', '403:NOT_LEADER'] : ['200', '200']);
      expect(await memberIds(team.id)).toEqual((leaveFirst ? [1] : [1, 2]).map((i) => fixture.actors[i]!.id).sort());
      expect((await fixture.pool.query('SELECT leader_id FROM teams WHERE id=$1', [team.id])).rows[0]!.leader_id).not.toBe(fixture.actors[0]!.id);
      expect((await requestState(requestId)).status).toBe(leaveFirst ? 'pending' : 'accepted');
      expect(fixture.published).toHaveLength(leaveFirst ? 1 : 2);
    });
  }
  for (const action of ['accept', 'decline']) {
    it(`20 concurrent ${action} decisions with one key return one committed outcome`, async () => {
      const fixture = f = await raceFixture(2); const team = await fixture.create(0); const requestId = await apply(1, team.id); const key = randomUUID(); fixture.published.length = 0;
      const results = await fireAtOnce(Array.from({ length: 20 }, () => () => decide(0, requestId, key, action)));
      expect(results.map(outcome)).toEqual(Array<string>(20).fill('200'));
      for (const result of results) expect(result.body).toEqual(results[0]!.body);
      expect(results.filter((r) => r.headers['idempotent-replay'] === 'true')).toHaveLength(19);
      expect(await keysFor([key])).toBe(1);
      expect(await auditActions(team.id)).toEqual(['team.created', 'request.created', ...(action === 'accept' ? ['request.accepted', 'member.joined'] : ['request.declined'])]);
      expect((await memberIds(team.id)).length).toBe(action === 'accept' ? 2 : 1); expect(fixture.published).toHaveLength(1);
    });
  }
  for (const acceptFirst of [true, false]) {
    it(`accept versus decline with different keys: ${acceptFirst ? 'accept' : 'decline'} locks first`, async () => {
      const race = orderedRace(); const fixture = f = await raceFixture(2, { observe: race.observe });
      const team = await fixture.create(0); const requestId = await apply(1, team.id); fixture.published.length = 0;
      const results = await race.run(fixture, (key) => decide(0, requestId, key, acceptFirst ? 'accept' : 'decline'), (key) => decide(0, requestId, key, acceptFirst ? 'decline' : 'accept'));
      expect(results.map(outcome)).toEqual(['200', '409:REQUEST_NOT_PENDING']);
      expect((await requestState(requestId)).status).toBe(acceptFirst ? 'accepted' : 'declined');
      expect((await memberIds(team.id)).length).toBe(acceptFirst ? 2 : 1); expect(fixture.published).toHaveLength(1);
    });
  }
  for (const action of ['accept', 'decline']) {
    for (const withdrawFirst of [true, false]) {
      it(`withdrawal versus ${action}: ${withdrawFirst ? 'withdrawal' : action} changes the request first`, async () => {
        const race = orderedRace(withdrawFirst ? cancellationWrite : decisionWrite, withdrawFirst ? decisionWrite : cancellationWrite);
        const fixture = f = await raceFixture(2, { observe: race.observe }); const team = await fixture.create(0); const requestId = await apply(1, team.id); fixture.published.length = 0;
        const withdraw = (key: string) => fixture.call(1, `/requests/${requestId}`, {}, key, 'DELETE');
        const decision = (key: string) => decide(0, requestId, key, action);
        const results = await race.run(fixture, withdrawFirst ? withdraw : decision, withdrawFirst ? decision : withdraw);
        expect(results.map(outcome)).toEqual(['200', '409:REQUEST_NOT_PENDING']);
        const status = withdrawFirst ? 'cancelled' : action === 'accept' ? 'accepted' : 'declined';
        expect((await requestState(requestId)).status).toBe(status);
        expect((await memberIds(team.id)).length).toBe(status === 'accepted' ? 2 : 1);
        expect(await auditActions(team.id)).toEqual(['team.created', 'request.created', `request.${status}`, ...(status === 'accepted' ? ['member.joined'] : [])]);
        expect(fixture.published).toHaveLength(1);
      });
    }
  }
  for (const joinFirst of [true, false]) {
    it(`automatic cancellation versus decline: ${joinFirst ? 'joining elsewhere' : 'decline'} changes the request first`, async () => {
      const race = orderedRace(joinFirst ? cancellationWrite : decisionWrite, joinFirst ? decisionWrite : cancellationWrite);
      const fixture = f = await raceFixture(3, { observe: race.observe }); const team = await fixture.create(0); const other = await fixture.create(1);
      const requestId = await apply(2, team.id); fixture.published.length = 0;
      const join = (key: string) => fixture.join(2, other.inviteCode!, key);
      const decline = (key: string) => decide(0, requestId, key, 'decline');
      const results = await race.run(fixture, joinFirst ? join : decline, joinFirst ? decline : join);
      expect(results.map(outcome)).toEqual(joinFirst ? ['200', '409:REQUEST_NOT_PENDING'] : ['200', '200']);
      expect(await memberIds(other.id)).toEqual([fixture.actors[1]!.id, fixture.actors[2]!.id].sort());
      expect((await requestState(requestId)).status).toBe(joinFirst ? 'cancelled' : 'declined');
      expect(await auditActions(team.id)).toEqual(['team.created', 'request.created', joinFirst ? 'request.cancelled' : 'request.declined']);
      expect(fixture.published).toHaveLength(joinFirst ? 1 : 2);
    });
  }
});
