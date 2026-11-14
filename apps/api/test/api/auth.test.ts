import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SignJWT, decodeJwt } from 'jose';
import { verify } from '@node-rs/argon2';
import { createApp } from '../../src/app.js';
import { readConfig } from '../../src/config.js';
import type { Config } from '../../src/config.js';
import { createSessions, issuer, audience } from '../../src/modules/auth/session.js';
import { testDatabase } from '../helpers/database.js';
import { testServer } from '../helpers/testServer.js';

const origin = 'http://localhost:5173';
const password = 'test-password-with-enough-characters';
let db: Awaited<ReturnType<typeof testDatabase>>;
let server: Awaited<ReturnType<typeof testServer>>;
let config: Config;

async function request(path: string, options: { method?: string; body?: unknown; cookie?: string; origin?: string | null; headers?: Record<string, string> } = {}) {
  return fetch(`${server.url}/api${path}`, {
    method: options.method ?? 'GET',
    headers: { ...(options.origin !== null ? { Origin: options.origin ?? origin } : {}),
      ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(options.cookie ? { Cookie: options.cookie } : {}), ...options.headers },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
}
const sessionCookie = (response: Response) => response.headers.get('set-cookie')!.split(';')[0]!;
async function account() {
  const email = `${randomUUID()}@example.test`;
  const response = await request('/auth/signup', { method: 'POST', body: { email, password, displayName: 'Test builder' } });
  expect(response.status).toBe(201);
  const cookie = sessionCookie(response);
  const profile = await (await request('/me', { cookie })).json() as { id: string; email: string };
  return { cookie, email, id: profile.id, response };
}
async function event() {
  const id = randomUUID();
  await db.pool.query("INSERT INTO hackathons (id, name, min_team_size, max_team_size) VALUES ($1, 'Identity test event', 2, 4)", [id]);
  return id;
}

beforeAll(async () => {
  db = await testDatabase();
  config = readConfig({ DATABASE_URL: db.connectionString, JWT_SECRET: 'identity-test-only-secret-0123456789abcdef0123456789', APP_ORIGIN: origin, NODE_ENV: 'test' });
});
beforeEach(async () => {
  server = await testServer(createApp({ checkDatabase: async () => { await db.pool.query('SELECT 1'); }, identity: { pool: db.pool, config } }));
});
afterEach(async () => { await server?.close(); });
afterAll(async () => { await db?.dispose(); });

describe('accounts and session cookies over HTTP', () => {
  it('signs up, hashes with Argon2id, returns only a safe own-profile DTO and rejects case-insensitive duplicates', async () => {
    const { response, cookie, email, id } = await account();
    expect(await response.json()).toEqual({ authenticated: true });
    const own = await request('/me', { cookie });
    expect(own.headers.get('cache-control')).toBe('no-store');
    expect(await own.json()).toEqual({ id, email, displayName: 'Test builder', skills: [], utcOffsetMin: 0, registrations: [] });
    const { rows: [stored] } = await db.pool.query('SELECT password_hash, is_organizer FROM users WHERE id = $1', [id]);
    expect(stored.password_hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(await verify(stored.password_hash as string, password)).toBe(true);
    expect(stored.is_organizer).toBe(false);
    expect((await request('/auth/signup', { method: 'POST', body: { email: email.toUpperCase(), password, displayName: 'Duplicate' } })).status).toBe(409);
  });

  it('logs in with normalized email, clears the cookie on logout, and preserves the documented stateless-token tradeoff', async () => {
    const user = await account();
    const login = await request('/auth/login', { method: 'POST', body: { email: ` ${user.email.toUpperCase()} `, password } });
    expect(login.status).toBe(200);
    expect(await login.json()).toEqual({ authenticated: true });
    const logout = await request('/auth/logout', { method: 'POST', body: {}, cookie: sessionCookie(login) });
    expect(logout.status).toBe(204);
    expect(logout.headers.get('set-cookie')).toMatch(/sid=;.*Path=\/;.*Expires=Thu, 01 Jan 1970.*HttpOnly.*SameSite=Lax/);
    expect((await request('/me')).status).toBe(401);
    // Logout removes the browser cookie; a separately retained valid JWT is not revoked.
    expect((await request('/me', { cookie: user.cookie })).status).toBe(200);
  });

  it('issues a seven-day HS256 cookie with local flags', async () => {
    const { response, cookie, id } = await account();
    const header = response.headers.get('set-cookie')!;
    expect(header).toContain('Max-Age=604800');
    expect(header).toContain('Path=/'); expect(header).toContain('HttpOnly'); expect(header).toContain('SameSite=Lax');
    expect(header).not.toContain('Secure');
    const token = cookie.slice(4);
    const claims = decodeJwt(token);
    expect(claims.sub).toBe(id); expect(claims.exp! - claims.iat!).toBe(604800);
    expect(JSON.parse(Buffer.from(token.split('.')[0]!, 'base64url').toString())).toEqual({ alg: 'HS256', typ: 'JWT' });
  });

  it('sets and clears Secure cookies in production', async () => {
    await server.close();
    const production = { ...config, NODE_ENV: 'production' as const, APP_ORIGIN: 'https://teamforge.test' };
    server = await testServer(createApp({ checkDatabase: async () => {}, production: true, identity: { pool: db.pool, config: production } }));
    const response = await request('/auth/signup', { method: 'POST', origin: production.APP_ORIGIN, body: { email: `${randomUUID()}@example.test`, password, displayName: 'Builder' } });
    expect(response.status).toBe(201);
    expect(response.headers.get('set-cookie')).toMatch(/HttpOnly; Secure; SameSite=Lax/);
    const logout = await request('/auth/logout', { method: 'POST', origin: production.APP_ORIGIN, cookie: sessionCookie(response) });
    expect(logout.status).toBe(204); expect(logout.headers.get('set-cookie')).toContain('Secure');
  });

  it('gives identical generic failures for a wrong password and unknown email', async () => {
    const { email } = await account();
    const messages = [];
    for (const address of [email, `${randomUUID()}@example.test`]) {
      const response = await request('/auth/login', { method: 'POST', body: { email: address, password: 'an-incorrect-password' } });
      expect(response.status).toBe(401);
      const { error } = await response.json() as { error: Record<string, unknown> };
      expect(error.requestId).toBe(response.headers.get('x-request-id'));
      delete error.requestId; messages.push(error);
    }
    expect(messages).toEqual(Array(2).fill({ code: 'UNAUTHENTICATED', message: 'Email or password is incorrect.' }));
  });

  it('rejects missing, corrupted, expired, wrong-algorithm, wrong-issuer and incomplete tokens', async () => {
    const { id, cookie } = await account();
    const now = Math.floor(Date.now() / 1000);
    const key = new TextEncoder().encode(config.JWT_SECRET);
    const sign = (payload: Record<string, unknown>, alg = 'HS256') => new SignJWT(payload).setProtectedHeader({ alg }).sign(key);
    const base = { sub: id, iat: now, exp: now + 3600, iss: issuer, aud: audience };
    const invalid = [
      '', 'sid=nonsense', `${cookie}x`, `${cookie}; ${cookie}`,
      `sid=${await sign({ ...base, iat: now - 7200, exp: now - 3600 })}`,
      `sid=${await sign(base, 'HS384')}`, `sid=${await sign({ ...base, iss: 'another-app' })}`,
      `sid=${await sign({ ...base, aud: 'another-client' })}`, `sid=${await sign({ ...base, sub: 'not-a-uuid' })}`,
      `sid=${await sign({ ...base, iat: now + 3600 })}`, `sid=${await sign({ ...base, exp: now + 604801 })}`,
      `sid=${await sign({ sub: id, iat: now, iss: issuer, aud: audience })}`,
      `sid=${await sign({ sub: id, exp: now + 3600, iss: issuer, aud: audience })}`,
      `sid=${await createSessions(config).issue(randomUUID())}`,
      `sid=${await sign(base).then((token) => `${token.split('.').slice(0, 2).join('.')}.`)}`,
    ];
    for (const badCookie of invalid) expect((await request('/me', { cookie: badCookie })).status).toBe(401);
  });
});

describe('profile, registration and validation boundaries', () => {
  it('edits only the authenticated profile and rejects identity/privilege injection', async () => {
    const a = await account(); const b = await account();
    const update = await request('/me', { method: 'PATCH', cookie: a.cookie, body: { displayName: '  Ada Builder  ', skills: ['frontend', 'design'], utcOffsetMin: 330 } });
    expect(update.status).toBe(200);
    expect(await update.json()).toMatchObject({ id: a.id, displayName: 'Ada Builder', skills: ['frontend', 'design'], utcOffsetMin: 330 });
    for (const field of ['id', 'userId', 'isOrganizer', 'is_organizer', 'email', 'password_hash']) {
      expect((await request('/me', { method: 'PATCH', cookie: a.cookie, body: { [field]: b.id, displayName: 'Injected' } })).status).toBe(400);
    }
    expect((await request(`/users/${b.id}`, { method: 'PATCH', cookie: a.cookie, body: { displayName: 'Injected' } })).status).toBe(404);
    expect(await (await request('/me', { cookie: b.cookie })).json()).toMatchObject({ displayName: 'Test builder', skills: [], utcOffsetMin: 0 });
    const { rows } = await db.pool.query('SELECT is_organizer FROM users WHERE id = ANY($1::uuid[])', [[a.id, b.id]]);
    expect(rows.every((row) => row.is_organizer === false)).toBe(true);
  });

  it('rejects unknown signup/login fields and invalid profile values without changes', async () => {
    const { cookie, email } = await account();
    expect((await request('/auth/signup', { method: 'POST', body: { email: `${randomUUID()}@example.test`, password, displayName: 'Builder', isOrganizer: true } })).status).toBe(400);
    expect((await request('/auth/login', { method: 'POST', body: { email, password, role: 'admin' } })).status).toBe(400);
    for (const body of [{}, { displayName: ' ' }, { displayName: 'a'.repeat(61) }, { displayName: 'A\u0000B' }, { skills: ['invented'] }, { skills: ['ml', 'ml'] }, { utcOffsetMin: 841 }, { utcOffsetMin: -721 }, { utcOffsetMin: 3.5 }, { skills: null }]) {
      expect((await request('/me', { method: 'PATCH', cookie, body })).status).toBe(400);
    }
    expect(await (await request('/me', { cookie })).json()).toMatchObject({ displayName: 'Test builder', skills: [], utcOffsetMin: 0 });
  });

  it('rejects missing/foreign/null Origins and non-JSON or oversized bodies', async () => {
    const { cookie } = await account();
    for (const badOrigin of [null, 'null', 'https://evil.test', `${origin}/`]) {
      expect((await request('/me', { method: 'PATCH', cookie, origin: badOrigin, body: { displayName: 'Injected' } })).status).toBe(403);
    }
    expect((await request('/me', { method: 'PATCH', cookie, body: { displayName: 'Injected' }, headers: { 'Content-Type': 'text/plain' } })).status).toBe(400);
    expect((await request('/me', { method: 'PATCH', cookie, body: { displayName: 'a'.repeat(11_000) } })).status).toBe(413);
    expect((await request(`/me?${'x'.repeat(2100)}`, { cookie })).status).toBe(400);
    expect((await request('/me?userId=another-user', { cookie })).status).toBe(400);
    expect(await (await request('/me', { cookie })).json()).toMatchObject({ displayName: 'Test builder' });
  });

  it('lists and retrieves hackathons, registers naturally idempotently under concurrency, and isolates preferences', async () => {
    const a = await account(); const b = await account(); const hid = await event();
    expect((await request('/hackathons')).status).toBe(401);
    expect((await request(`/hackathons/${hid}`)).status).toBe(401);
    expect(await (await request(`/hackathons/${hid}`, { cookie: a.cookie })).json()).toEqual({ id: hid, name: 'Identity test event', minTeamSize: 2, maxTeamSize: 4, registration: null });
    const responses = await Promise.all(Array.from({ length: 20 }, () => request(`/hackathons/${hid}/register`, { method: 'POST', cookie: a.cookie, body: {} })));
    expect(responses.every((r) => r.status === 200)).toBe(true);
    const bodies = await Promise.all(responses.map((r) => r.json()));
    expect(bodies.every((body) => JSON.stringify(body) === JSON.stringify(bodies[0]))).toBe(true);
    expect((await db.pool.query('SELECT * FROM hackathon_participants WHERE hackathon_id = $1', [hid])).rowCount).toBe(1);
    const preference = await request(`/hackathons/${hid}/me`, { method: 'PATCH', cookie: a.cookie, body: { openToInvites: false } });
    expect(preference.status).toBe(200);
    expect(await preference.json()).toMatchObject({ hackathonId: hid, openToInvites: false });
    expect(await (await request(`/hackathons/${hid}/register`, { method: 'POST', cookie: a.cookie })).json()).toMatchObject({ openToInvites: false });
    expect((await request(`/hackathons/${hid}/me`, { method: 'PATCH', cookie: b.cookie, body: { openToInvites: false } })).status).toBe(403);
    expect((await request(`/hackathons/${hid}/register`, { method: 'POST', cookie: b.cookie, body: { userId: a.id } })).status).toBe(400);
    expect((await request(`/hackathons/${hid}/me`, { method: 'PATCH', cookie: a.cookie, body: { openToInvites: false, userId: b.id } })).status).toBe(400);
    const list = await (await request('/hackathons', { cookie: a.cookie })).json() as { items: { id: string; registration: unknown }[] };
    expect(list.items.find((item) => item.id === hid)?.registration).toMatchObject({ openToInvites: false });
    expect(await (await request('/me', { cookie: a.cookie })).json()).toMatchObject({ registrations: [{ hackathonId: hid, openToInvites: false }] });
    expect(await (await request('/me', { cookie: b.cookie })).json()).toMatchObject({ registrations: [] });
  });

  it('validates UUID params and reports missing events without creating registrations', async () => {
    const { cookie } = await account();
    expect((await request('/hackathons/not-a-uuid', { cookie })).status).toBe(400);
    expect((await request(`/hackathons/${randomUUID()}`, { cookie })).status).toBe(404);
    expect((await request(`/hackathons/${randomUUID()}/register`, { method: 'POST', cookie })).status).toBe(404);
    expect((await request('/hackathons/not-a-uuid/register', { method: 'POST', cookie })).status).toBe(400);
  });
});

describe('independent application rate limits', () => {
  it('limits failed login attempts even with forged forwarded IPs and simultaneous requests', async () => {
    const email = `${randomUUID()}@example.test`;
    const responses = await Promise.all(Array.from({ length: 11 }, (_, i) => request('/auth/login', {
      method: 'POST', body: { email, password }, headers: { 'X-Forwarded-For': `192.0.2.${i + 1}` },
    })));
    expect(responses.filter((r) => r.status === 401)).toHaveLength(10);
    expect(responses.filter((r) => r.status === 429)).toHaveLength(1);
    expect(Number(responses.find((r) => r.status === 429)!.headers.get('retry-after'))).toBeGreaterThan(0);
    expect((await request('/auth/login', { method: 'POST', body: { email: `${randomUUID()}@example.test`, password } })).status).toBe(429);
  });

  it('counts failed logins per normalized email across explicitly trusted proxy IPs', async () => {
    await server.close();
    server = await testServer(createApp({ checkDatabase: async () => {}, identity: { pool: db.pool, config: { ...config, TRUSTED_PROXY_CIDRS: ['127.0.0.1/32'] } } }));
    const email = `${randomUUID()}@example.test`;
    for (let i = 0; i < 10; i++) expect((await request('/auth/login', { method: 'POST', body: { email, password }, headers: { 'X-Forwarded-For': `192.0.2.${i + 1}` } })).status).toBe(401);
    expect((await request('/auth/login', { method: 'POST', body: { email: email.toUpperCase(), password }, headers: { 'X-Forwarded-For': '192.0.2.100' } })).status).toBe(429);
    expect((await request('/auth/login', { method: 'POST', body: { email: `${randomUUID()}@example.test`, password }, headers: { 'X-Forwarded-For': '192.0.2.100' } })).status).toBe(401);
  });

  it('refunds successful logins without erasing earlier failures', async () => {
    const { email } = await account();
    for (let i = 0; i < 9; i++) expect((await request('/auth/login', { method: 'POST', body: { email, password: 'incorrect-password' } })).status).toBe(401);
    for (let i = 0; i < 11; i++) expect((await request('/auth/login', { method: 'POST', body: { email, password } })).status).toBe(200);
    expect((await request('/auth/login', { method: 'POST', body: { email, password: 'incorrect-password' } })).status).toBe(401);
    expect((await request('/auth/login', { method: 'POST', body: { email, password } })).status).toBe(429);
  });

  it('caps signup at 20 attempts per hour independently of login state', async () => {
    const user = await account();
    for (let i = 1; i < 20; i++) expect((await request('/auth/signup', { method: 'POST', body: { email: user.email, password, displayName: 'Builder' } })).status).toBe(409);
    expect((await request('/auth/signup', { method: 'POST', body: { email: `${randomUUID()}@example.test`, password, displayName: 'Builder' }, headers: { 'X-Forwarded-For': '192.0.2.99' } })).status).toBe(429);
    expect((await request('/auth/login', { method: 'POST', body: { email: user.email, password } })).status).toBe(200);
  });

  it('caps mutations per user without consuming another user or read quota', async () => {
    const a = await account(); const b = await account();
    for (let i = 0; i < 60; i++) expect((await request('/me', { method: 'PATCH', cookie: a.cookie, body: { utcOffsetMin: i } })).status).toBe(200);
    expect((await request('/me', { method: 'PATCH', cookie: a.cookie, body: { utcOffsetMin: 0 } })).status).toBe(429);
    expect((await request('/me', { cookie: a.cookie })).status).toBe(200);
    expect((await request('/me', { method: 'PATCH', cookie: b.cookie, body: { utcOffsetMin: 0 } })).status).toBe(200);
  });

  it('caps reads at 600 per user per minute separately from mutations', async () => {
    const a = await account(); const b = await account();
    // account() consumed one read for each account already.
    for (let i = 1; i < 600; i++) expect((await request('/me', { cookie: a.cookie })).status).toBe(200);
    expect((await request('/me', { cookie: a.cookie })).status).toBe(429);
    expect((await request('/me', { cookie: b.cookie })).status).toBe(200);
    expect((await request('/me', { method: 'PATCH', cookie: a.cookie, body: { utcOffsetMin: 0 } })).status).toBe(200);
  });
});
