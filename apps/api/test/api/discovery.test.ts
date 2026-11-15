import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BoardTeam, Page, RequestResult, Suggestions } from '@teamforge/shared';
import { raceFixture, outcome } from '../helpers/raceFixture.js';
import type { RaceFixture } from '../helpers/raceFixture.js';
import { bounded } from '../helpers/signals.js';
import { createDiscovery } from '../../src/modules/discovery/routes.js';
import type { Discovery } from '../../src/modules/discovery/routes.js';
import { createParticipants } from '../helpers/factories.js';

describe('discovery and live HTTP boundaries', () => {
  let f: RaceFixture; let discovery: Discovery; const controllers: AbortController[] = [];
  beforeEach(async () => { discovery = createDiscovery(); f = await raceFixture(9, { discovery }); });
  afterEach(async () => {
    for (const controller of controllers.splice(0)) controller.abort();
    vi.restoreAllMocks();
    if (f) { try { await f.idle(); await f.invariantReport(); } finally { await f.dispose(); } }
  });
  const get = (actor: number, path: string, headers: Record<string, string> = {}) => fetch(`${f.baseUrl}/api/hackathons/${f.hackathonId}${path}`, { headers: { Cookie: f.actors[actor]!.cookie, ...headers } });
  const page = async (path = '/teams') => {
    const response = await get(8, path); expect(response.status).toBe(200); return response.json() as Promise<Page<BoardTeam>>;
  };
  const patch = (actor: number, path: string, body: unknown) => f.call(actor, path, body, randomUUID(), 'PATCH');
  async function stream(actor: number) {
    const controller = new AbortController(); controllers.push(controller);
    const response = await fetch(`${f.baseUrl}/api/hackathons/${f.hackathonId}/stream`, { headers: { Cookie: f.actors[actor]!.cookie }, signal: controller.signal });
    expect(response.status).toBe(200); expect(response.headers.get('content-type')).toMatch(/^text\/event-stream(?:;|$)/);
    expect(response.headers.get('cache-control')).toBe('no-cache, no-transform'); expect(response.headers.get('x-accel-buffering')).toBe('no');
    const queued: Array<{ event: string; data: unknown }> = [];
    let notify = () => {}; let stopped = false;
    const reader = response.body!.getReader(); const decoder = new TextDecoder(); let buffer = '';
    const reading = (async () => {
      try {
        for (;;) {
          const chunk = await reader.read(); if (chunk.done) break; buffer += decoder.decode(chunk.value, { stream: true });
          let end: number;
          while ((end = buffer.indexOf('\n\n')) >= 0) {
            const block = buffer.slice(0, end); buffer = buffer.slice(end + 2);
            const event = block.split('\n').find((s) => s.startsWith('event: '))?.slice(7);
            const data = block.split('\n').find((s) => s.startsWith('data: '))?.slice(6);
            if (event && data) { queued.push({ event, data: JSON.parse(data) as unknown }); notify(); }
          }
        }
      } catch (error) { if (!controller.signal.aborted) throw error; }
      finally { stopped = true; notify(); }
    })();
    return { close: async () => { controller.abort(); await reading; }, next: async (event: string) => bounded((async () => {
      for (;;) {
        const index = queued.findIndex((item) => item.event === event);
        if (index >= 0) return queued.splice(index,1)[0]!.data;
        if (stopped) throw new Error('Stream closed before event');
        await new Promise<void>((resolve) => { notify = resolve; });
      }
    })()) };
  }

  it('lists only open teams with seats and returns a public DTO without member/invite/request data', async () => {
    const open = await f.create(0); const closed = await f.create(1); await patch(1, `/teams/${closed.id}`, { isOpen: false });
    await f.team([2,3,4,5]); const result = await page(); expect(result.items.map((t) => t.id)).toEqual([open.id]);
    expect(result.items[0]).toMatchObject({ openSeats: 3, memberCount: 1, ready: false });
    expect(JSON.stringify(result)).not.toMatch(/invite|password|email|members|request/i);
  });
  it('filters by needs and escaped literal search including percent, underscore and backslash', async () => {
    const a = await f.create(0, '100%_\\ Builders'); await f.create(1, '100xx Builders');
    await patch(0, `/teams/${a.id}`, { lookingFor: ['design'] });
    expect((await page('/teams?needs=design&q=' + encodeURIComponent('  %_\\  '))).items.map((t) => t.id)).toEqual([a.id]);
    expect((await page('/teams?needs=backend')).items).toEqual([]);
  });
  it('paginates deterministically across microseconds and equal timestamp ties', async () => {
    for (const actor of [0,1,2,3]) await f.create(actor);
    await f.pool.query("UPDATE teams SET created_at='2026-01-01T00:00:00.123456Z'");
    await f.pool.query("UPDATE teams SET created_at='2026-01-01T00:00:00.123789Z' WHERE leader_id=$1", [f.actors[0]!.id]);
    const expected=(await f.pool.query<{id:string}>('SELECT id FROM teams ORDER BY created_at DESC,id DESC')).rows.map((r)=>r.id);
    let cursor: string | null = null; const ids: string[] = [];
    do {
      const result = await page(`/teams?limit=1${cursor ? `&cursor=${cursor}` : ''}`); ids.push(...result.items.map((t) => t.id)); cursor=result.nextCursor;
      if(ids.length===1) await f.create(4,'Inserted after the first page');
      expect(ids.length).toBeLessThanOrEqual(4);
    } while (cursor);
    expect(ids).toEqual(expected);
  });
  it('validates filters/cursors and authenticates even cache hits and conditional requests', async () => {
    await f.create(0); const first = await get(8, '/teams'); const etag = first.headers.get('etag')!;
    // Undici adds Cache-Control: no-cache to a conditional fetch by default,
    // explicitly demanding a full response under Express's freshness rules.
    const conditional = await get(8, '/teams', { 'If-None-Match': etag, 'Cache-Control': 'max-age=0' }); expect(conditional.status).toBe(304);
    expect(conditional.headers.get('vary')).toContain('Accept-Encoding');
    for (const query of ['needs=invalid', 'limit=51', 'q=a&q=b', 'cursor=invalid', 'unexpected=1']) expect((await get(8, `/teams?${query}`)).status).toBe(400);
    await f.pool.query('DELETE FROM hackathon_participants WHERE user_id=$1', [f.actors[8]!.id]);
    expect((await get(8, '/teams', { 'If-None-Match': etag })).status).toBe(403);
    expect((await get(7, '/teams', { Cookie: '' })).status).toBe(401);
  });
  it('invalidates loaded/filter pages after close, reopen, fill, leave and delete', async () => {
    const team = await f.team([0,1,2]); expect((await page()).items).toHaveLength(1);
    await patch(0, `/teams/${team.id}`, { isOpen: false }); expect((await page()).items).toEqual([]);
    await patch(0, `/teams/${team.id}`, { isOpen: true, lookingFor: ['design'] }); expect((await page('/teams?needs=design')).items).toHaveLength(1);
    await f.join(3, team.inviteCode!); expect((await page('/teams?needs=design')).items).toEqual([]);
    for (const actor of [3,2,1]) { expect(outcome(await f.call(actor, `/teams/${team.id}/leave`, {}))).toBe('200'); expect((await page()).items).toHaveLength(1); }
    await f.call(0, `/teams/${team.id}/leave`, {}); expect((await page()).items).toEqual([]);
  });
  it('invalidates public leader display names after a profile edit', async () => {
    await f.create(0); await page();
    const response = await fetch(`${f.baseUrl}/api/me`, { method: 'PATCH', headers: { Origin: 'http://localhost:5173', Cookie: f.actors[0]!.cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ displayName: 'New public name' }) });
    expect(response.status).toBe(200); expect((await page()).items[0]!.leader.displayName).toBe('New public name');
  });
  it('ranks only eligible solo opted-in participants with deterministic ties and explanations', async () => {
    const team = await f.team([0,1]); await f.create(2);
    await patch(0, `/teams/${team.id}`, { lookingFor: ['design','ml'] });
    await f.pool.query("UPDATE users SET skills=ARRAY['frontend','backend'],utc_offset_min=330 WHERE id=ANY($1::uuid[])", [[f.actors[0]!.id,f.actors[1]!.id]]);
    await f.pool.query("UPDATE users SET skills=ARRAY['design','frontend'],utc_offset_min=360 WHERE id=ANY($1::uuid[])", [[f.actors[3]!.id,f.actors[4]!.id]]);
    await f.pool.query("UPDATE users SET skills=ARRAY['ml','data'],utc_offset_min=-300 WHERE id=$1", [f.actors[5]!.id]);
    await f.pool.query('UPDATE hackathon_participants SET open_to_invites=false WHERE user_id=$1', [f.actors[6]!.id]);
    await f.pool.query('DELETE FROM hackathon_participants WHERE user_id=$1', [f.actors[7]!.id]);
    const response = await get(1, `/teams/${team.id}/suggestions`); expect(response.status).toBe(200); const body = await response.json() as Suggestions;
    expect(body.items.slice(0,2).map((u) => u.userId)).toEqual([f.actors[3]!.id,f.actors[4]!.id].sort());
    expect(body.items.map((u) => u.score)).toEqual([65,65,42,11]);
    expect(body.scoring.weights).toEqual({ skill:0.65, timezone:0.35, needCoverage:0.7, complement:0.3 });
    expect(body.items[0]!.breakdown.total).toBe(65); expect(JSON.stringify(body)).not.toMatch(/password|email|inviteCode/);
    expect((await get(8, `/teams/${team.id}/suggestions`)).status).toBe(404);
  });
  it('scopes suggestions and the board to the authorized hackathon', async () => {
    const team=await f.create(0); const other=randomUUID();
    await f.pool.query("INSERT INTO hackathons(id,name,min_team_size,max_team_size) VALUES($1,'Other',2,4)",[other]);
    await f.pool.query('INSERT INTO hackathon_participants(hackathon_id,user_id) VALUES($1,$2)',[other,f.actors[0]!.id]);
    const headers={Cookie:f.actors[0]!.cookie};
    expect((await fetch(`${f.baseUrl}/api/hackathons/${other}/teams/${team.id}/suggestions`,{headers})).status).toBe(404);
    expect((await (await fetch(`${f.baseUrl}/api/hackathons/${other}/teams`,{headers})).json() as Page<BoardTeam>).items).toEqual([]);
  });
  it('scores the entire candidate set before taking the top twenty', async () => {
    const team=await f.create(0); await createParticipants(f.pool,25,f.hackathonId);
    const eligible=(await f.pool.query<{id:string}>('SELECT id FROM users WHERE id<>$1 ORDER BY id',[f.actors[0]!.id])).rows.map((r)=>r.id);
    const best=eligible.at(-1)!;
    await f.pool.query("UPDATE users SET skills=ARRAY['design'] WHERE id=$1",[best]);
    const result=await (await get(0,`/teams/${team.id}/suggestions`)).json() as Suggestions;
    expect(result.items.map((r)=>r.userId)).toEqual([best,...eligible.slice(0,19)]);
    expect(result.items[0]!.score).toBe(100);
  });
  it('sends only public invalidations to two clients after join, accept and leave commits', async () => {
    const team=await f.create(0); const first=await stream(0); const second=await stream(1);
    expect(await first.next('hello')).toHaveProperty('serverTime'); await second.next('hello');
    await f.join(1,team.inviteCode!);
    for (const s of [first,second]) expect(await s.next('state.changed')).toEqual({hackathonId:f.hackathonId});
    expect((await page()).items[0]!.memberCount).toBe(2);
    const request=await f.call<RequestResult>(2,`/teams/${team.id}/requests`,{message:'Private application text'});
    for (const s of [first,second]) await s.next('state.changed');
    await f.call(0,`/requests/${request.body.request.id}/accept`,{});
    for (const s of [first,second]) expect(await s.next('state.changed')).toEqual({hackathonId:f.hackathonId});
    await f.call(1,`/teams/${team.id}/leave`,{});
    for (const s of [first,second]) expect(await s.next('state.changed')).toEqual({hackathonId:f.hackathonId});
    await first.close(); await second.close();
  });
  it('does not invalidate or publish on rollback and replays without a second publication', async () => {
    const team=await f.team([0,1,2]); const request=await f.call<RequestResult>(3,`/teams/${team.id}/requests`,{});
    await f.join(4,team.inviteCode!); const changed=vi.spyOn(discovery,'changed');
    expect(outcome(await f.call(0,`/requests/${request.body.request.id}/accept`,{}))).toBe('409:TEAM_FULL'); expect(changed).not.toHaveBeenCalled();
    const key=randomUUID(); const path=`/teams/${team.id}`;
    await f.call(0,path,{description:'New'},key,'PATCH'); await f.call(0,path,{description:'New'},key,'PATCH'); expect(changed).toHaveBeenCalledTimes(1);
  });
  it('requires authentication/registration for streams and rejects a fourth live tab', async () => {
    expect((await get(0,'/stream',{Cookie:''})).status).toBe(401);
    await f.pool.query('DELETE FROM hackathon_participants WHERE user_id=$1',[f.actors[8]!.id]); expect((await get(8,'/stream')).status).toBe(403);
    const streams=[]; for(let i=0;i<3;i++) { const s=await stream(0); await s.next('hello'); streams.push(s); }
    const limited=await get(0,'/stream'); expect(limited.status).toBe(429); expect(limited.headers.get('retry-after')).toBe('3');
    for(const s of streams) await s.close();
    const reopened=await stream(0); await reopened.next('hello'); await reopened.close();
  });
  it('former leaders and removed members cannot refetch protected data', async () => {
    const team=await f.team([0,1,2]); await f.call(0,`/teams/${team.id}/leave`,{});
    expect((await get(0,`/teams/${team.id}/invite`)).status).toBe(403); expect((await get(0,`/teams/${team.id}/requests`)).status).toBe(403);
    const current=(await f.pool.query<{leader_id:string}>('SELECT leader_id FROM teams WHERE id=$1',[team.id])).rows[0]!.leader_id;
    const leader=f.actors.findIndex((a)=>a.id===current); const removed=leader===1?2:1;
    await f.call(leader,`/teams/${team.id}/members/${f.actors[removed]!.id}`,{},randomUUID(),'DELETE');
    for(const suffix of ['audit','suggestions']) expect((await get(removed,`/teams/${team.id}/${suffix}`)).status).toBe(404);
    expect(JSON.stringify(await (await get(0,`/teams/${team.id}`)).json())).not.toContain('inviteCode');
  });
  it('limits stream connection attempts even when the concurrent limit rejects them', async () => {
    const streams=[]; for(let i=0;i<3;i++) { const s=await stream(0); await s.next('hello'); streams.push(s); }
    for(let i=3;i<30;i++) expect((await get(0,'/stream')).headers.get('retry-after')).toBe('3');
    for(const s of streams) await s.close();
    const limited=await get(0,'/stream'); expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(3);
  });
});
