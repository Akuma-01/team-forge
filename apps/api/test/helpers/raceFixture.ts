import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { request } from 'node:http';
import type { IncomingHttpHeaders } from 'node:http';
import pg from 'pg';
import { SignJWT } from 'jose';
import { apiErrorSchema } from '@teamforge/shared';
import type { CreateTeamResult, JoinTeamResult, TeamDetail } from '@teamforge/shared';
import { createApp } from '../../src/app.js';
import { readConfig } from '../../src/config.js';
import { issuer, audience } from '../../src/modules/auth/session.js';
import type { TeamChange } from '../../src/modules/teams/service.js';
import { checkInvariants } from '../../src/db/invariants.js';
import { testDatabase } from './database.js';
import { createParticipants } from './factories.js';
import { testServer } from './testServer.js';
import { observePool } from './observePool.js';
import type { QueryObserver } from './observePool.js';
import { waitFor } from './concurrency.js';
import type { Discovery } from '../../src/modules/discovery/routes.js';

type Actor = { id: string; cookie: string; address: string };
export type RaceResponse<T = unknown> = { status: number; body: T; headers: IncomingHttpHeaders; sourceAddress: string; userId: string };
const origin = 'http://localhost:5173';

export async function raceFixture(count = 54, options: { maxSize?: number; observe?: QueryObserver; publish?: (change: TeamChange) => void | Promise<void>; discovery?: Discovery; sameIp?: boolean } = {}) {
  const db = await testDatabase();
  const observer = new pg.Pool({ ...db.pool.options, max: 1 });
  let server: Awaited<ReturnType<typeof testServer>> | undefined;
  try {
    assert.equal(db.pool.options.max, 20);
    const { users, hackathonId } = await createParticipants(db.pool, count);
    if (options.maxSize !== undefined) await db.pool.query('UPDATE hackathons SET min_team_size=1, max_team_size=$2 WHERE id=$1', [hackathonId, options.maxSize]);
    const config = readConfig({ DATABASE_URL: db.connectionString, JWT_SECRET: randomBytes(32).toString('hex'), APP_ORIGIN: origin, NODE_ENV: 'test', PG_POOL_MAX: '20' });
    const secret = new TextEncoder().encode(config.JWT_SECRET);
    // Established signed sessions avoid depending on a just-issued wall-clock
    // boundary. Normal API verification, user lookups and all rate limits run.
    const issuedAt = Math.floor(Date.now() / 1000) - 60;
    const actors: Actor[] = await Promise.all(users.map(async (id, index) => ({
      id, address: options.sameIp ? '127.0.0.1' : `127.0.0.${index + 2}`,
      cookie: `sid=${await new SignJWT({}).setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
        .setSubject(id).setIssuer(issuer).setAudience(audience).setIssuedAt(issuedAt).setExpirationTime(issuedAt + 604800).sign(secret)}`,
    })));
    const instrumented = options.observe ? observePool(db.pool, options.observe) : undefined;
    const published: TeamChange[] = [];
    server = await testServer(createApp({ checkDatabase: async () => { await db.pool.query('SELECT 1'); }, identity: {
      pool: instrumented?.pool ?? db.pool, config,
      ...(options.discovery ? { discovery: options.discovery } : {}),
      publishTeamChange: async (change) => { published.push(change); await options.publish?.(change); },
    } }));
    const baseUrl = server.url;
    let peakConnections = 0;
    db.pool.on('acquire', () => { peakConnections = Math.max(peakConnections, db.pool.totalCount); });

    const call = <T = unknown>(actorIndex: number, path: string, body: unknown, key: string | null = randomUUID(), method = 'POST', scopedHackathonId: string = hackathonId): Promise<RaceResponse<T>> => {
      const actor = actors[actorIndex]!;
      const data = JSON.stringify(body);
      return new Promise((resolve, reject) => {
        let sourceAddress: string | undefined;
        const req = request(`${baseUrl}/api/hackathons/${scopedHackathonId}${path}`, {
          method, agent: false, localAddress: actor.address,
          headers: { Origin: origin, Cookie: actor.cookie, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data),
            ...(key === null ? {} : { 'Idempotency-Key': key }) },
        }, (res) => {
          let text = '';
          res.setEncoding('utf8'); res.on('data', (chunk: string) => { text += chunk; });
          res.on('error', reject);
          res.on('end', () => {
            try {
              assert.match(String(res.headers['content-type']), /^application\/json/);
              assert.match(String(res.headers['x-request-id']), /^[0-9a-f-]{36}$/);
              assert.equal(sourceAddress, actor.address);
              resolve({ status: res.statusCode!, body: JSON.parse(text) as T, headers: res.headers, sourceAddress: sourceAddress!, userId: actor.id });
            } catch (error) { reject(error); }
          });
        });
        req.on('socket', (socket) => socket.once('connect', () => { sourceAddress = socket.localAddress; }));
        req.setTimeout(10_000, () => req.destroy(new Error('Race HTTP request timed out.')));
        req.on('error', reject); req.end(data);
      });
    };
    const create = async (actor: number, name = `Race ${randomUUID()}`): Promise<TeamDetail> => {
      const result = await call<CreateTeamResult>(actor, '/teams', { name });
      assert.equal(result.status, 201, `Create fixture: ${result.status}`);
      return result.body.team;
    };
    const join = (actor: number, code: string, key: string = randomUUID()) => call<JoinTeamResult>(actor, '/teams/join-by-code', { code }, key);
    const team = async (members = [0, 1, 2]) => {
      const created = await create(members[0]!);
      for (const actor of members.slice(1)) assert.equal((await join(actor, created.inviteCode!)).status, 200);
      return created;
    };
    const invariantReport = async () => {
      const checks = await checkInvariants(db.pool, hackathonId);
      assert.deepEqual(checks.filter((check) => check.violations.length), []);
      return checks.map((check) => ({ id: check.id, violations: check.violations.length }));
    };
    const idle = async () => {
      await waitFor(() => db.pool.waitingCount === 0 && db.pool.idleCount === db.pool.totalCount && (instrumented?.active.size ?? 0) === 0, 'all application connections to return', 3000);
      assert.ok(peakConnections <= 20);
    };
    const dispose = async () => {
      try { await server!.close(); }
      finally { await observer.end(); await db.dispose(); }
    };
    return { ...db, baseUrl, dispose, observer, actors, hackathonId, published, instrumented, call, create, join, team, invariantReport, idle,
      connections: () => ({ max: db.pool.options.max, peak: peakConnections, total: db.pool.totalCount, idle: db.pool.idleCount, waiting: db.pool.waitingCount }) };
  } catch (error) { await server?.close(); await observer.end(); await db.dispose(); throw error; }
}
export type RaceFixture = Awaited<ReturnType<typeof raceFixture>>;
export const outcome = (response: RaceResponse) => response.status >= 400
  ? `${response.status}:${apiErrorSchema.parse(response.body).error.code}` : String(response.status);
