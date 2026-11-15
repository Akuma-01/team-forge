import { randomBytes } from 'node:crypto';
import { SignJWT } from 'jose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { readConfig } from '../../src/config.js';
import { issuer, audience } from '../../src/modules/auth/session.js';
import { inviteCode } from '../../src/modules/teams/invite.js';
import { SlidingWindowLimiter } from '../../src/middleware/rateLimit.js';
import { testDatabase } from '../helpers/database.js';
import { createParticipants } from '../helpers/factories.js';
import { testServer } from '../helpers/testServer.js';
import { fireAtOnce } from '../helpers/concurrency.js';

describe('same-IP concurrent join rate limiting & failure budget isolation', () => {
  let db: Awaited<ReturnType<typeof testDatabase>>;
  let server: Awaited<ReturnType<typeof testServer>>;
  let hid: string;
  let users: string[];
  let cookies: string[];
  let limiter: SlidingWindowLimiter;
  const origin = 'http://localhost:5173';

  async function request(
    userIndex: number,
    path: string,
    method = 'POST',
    body?: unknown,
    ip = '198.51.100.1',
  ) {
    const url = `${server.url}/api/hackathons/${hid}${path}`;
    const cookie = userIndex >= 0 ? cookies[userIndex]! : '';
    const init: RequestInit = {
      method,
      headers: {
        Origin: origin,
        Cookie: cookie,
        'Content-Type': 'application/json',
        'X-Forwarded-For': ip, // Note: real server uses socket remoteAddress unless trusted proxy
      },
    };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
    }
    const res = await fetch(url, init);
    const text = await res.text();
    let json: unknown;
    try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, headers: res.headers, body: json };
  }

  beforeAll(async () => {
    db = await testDatabase();
  });

  beforeEach(async () => {
    const participants = await createParticipants(db.pool, 55);
    hid = participants.hackathonId;
    users = participants.users;
    limiter = new SlidingWindowLimiter();
    const config = readConfig({
      DATABASE_URL: db.connectionString,
      JWT_SECRET: randomBytes(32).toString('hex'),
      APP_ORIGIN: origin,
      NODE_ENV: 'test',
    });
    const secret = new TextEncoder().encode(config.JWT_SECRET);
    const issuedAt = Math.floor(Date.now() / 1000) - 60;
    cookies = await Promise.all(
      users.map(async (id) =>
        `sid=${await new SignJWT({})
          .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
          .setSubject(id)
          .setIssuer(issuer)
          .setAudience(audience)
          .setIssuedAt(issuedAt)
          .setExpirationTime(issuedAt + 604800)
          .sign(secret)}`,
      ),
    );

    server = await testServer(
      createApp({
        checkDatabase: async () => {},
        identity: { pool: db.pool, config, limiter },
      }),
    );
  });

  afterEach(async () => {
    await server?.close();
  });

  afterAll(async () => {
    await db?.dispose();
  });

  it('50 concurrent joins from ONE IP with valid code produce exactly 1 success and 49 TEAM_FULL (0 rate-limited)', async () => {
    // User 0 creates a team with max 2 members (1 seat left)
    await db.pool.query('UPDATE hackathons SET min_team_size=1, max_team_size=2 WHERE id=$1', [hid]);
    const createRes = await request(0, '/teams', 'POST', { name: 'Race Team' });
    expect(createRes.status).toBe(201);
    const team = (createRes.body as { team: { id: string; inviteCode: string } }).team;
    const validCode = team.inviteCode;

    // Contenders: 50 distinct users (index 1 to 50) firing simultaneously from the same local IP
    const contenders = Array.from({ length: 50 }, (_, i) => i + 1);
    const responses = await fireAtOnce(
      contenders.map((userIndex) => () =>
        request(userIndex, '/teams/join-by-code', 'POST', { code: validCode }),
      ),
    );

    const statusCounts: Record<number, number> = {};
    for (const r of responses) {
      statusCounts[r.status] = (statusCounts[r.status] ?? 0) + 1;
    }

    // Exactly 1 success (200), 49 full (409), and 0 rate-limited (429)
    expect(statusCounts).toEqual({ 200: 1, 409: 49 });
  });

  it('repeated invalid codes from one IP trigger 429 after 40 failures', async () => {
    // Send 40 invalid codes sequentially across 4 distinct users from the same client IP
    // Each user makes at most 10 attempts, testing the 40-attempt IP cap without tripping the 10-attempt user cap
    for (let i = 0; i < 40; i++) {
      const u = Math.floor(i / 10) + 1;
      const res = await request(u, '/teams/join-by-code', 'POST', { code: inviteCode() });
      expect(res.status).toBe(404);
    }

    // The 41st invalid attempt from this IP must trigger 429
    const limited = await request(4, '/teams/join-by-code', 'POST', { code: inviteCode() });
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  it('concurrent invalid-code attempts cannot bypass the failure budget of 40', async () => {
    // Fire 50 invalid code attempts concurrently across different users
    const attempts = Array.from({ length: 50 }, (_, i) => i + 1);
    const responses = await fireAtOnce(
      attempts.map((u) => () =>
        request(u, '/teams/join-by-code', 'POST', { code: inviteCode() }),
      ),
    );

    const statusCounts: Record<number, number> = {};
    for (const r of responses) {
      statusCounts[r.status] = (statusCounts[r.status] ?? 0) + 1;
    }

    // Exactly 40 attempts are permitted into the budget (404), and the remaining 10 are blocked with 429
    expect(statusCounts[404]).toBe(40);
    expect(statusCounts[429]).toBe(10);
  });

  it('successful requests and capacity conflicts (TEAM_FULL) do not consume the invalid-code quota', async () => {
    // Create a full team (max size 1, member count 1)
    await db.pool.query('UPDATE hackathons SET min_team_size=1, max_team_size=1 WHERE id=$1', [hid]);
    const createRes = await request(0, '/teams', 'POST', { name: 'Full Team' });
    const team = (createRes.body as { team: { id: string; inviteCode: string } }).team;

    // 40 users attempt to join the full team -> all get 409 TEAM_FULL
    for (let i = 1; i <= 40; i++) {
      const res = await request(i, '/teams/join-by-code', 'POST', { code: team.inviteCode });
      expect(res.status).toBe(409);
    }

    // Now send an invalid code attempt from user 41:
    // If TEAM_FULL had consumed the invalid-code budget, this would return 429.
    // Instead, it must return 404 because the invalid-code failure budget is untouched!
    const resInvalid = await request(41, '/teams/join-by-code', 'POST', { code: inviteCode() });
    expect(resInvalid.status).toBe(404);
  });

  it('rate-limit state is correctly released after request completion', async () => {
    // User 1 makes 50 sequential requests with a valid code
    await db.pool.query('UPDATE hackathons SET min_team_size=1, max_team_size=1 WHERE id=$1', [hid]);
    const createRes = await request(0, '/teams', 'POST', { name: 'Release Team' });
    const team = (createRes.body as { team: { id: string; inviteCode: string } }).team;

    for (let i = 1; i <= 25; i++) {
      const res = await request(i, '/teams/join-by-code', 'POST', { code: team.inviteCode });
      expect(res.status).toBe(409);
    }

    // Verify flood limiter released: subsequent request succeeds immediately without 429
    const res = await request(26, '/teams/join-by-code', 'POST', { code: team.inviteCode });
    expect(res.status).toBe(409);
  });
});
