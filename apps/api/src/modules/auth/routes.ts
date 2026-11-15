import { Router } from 'express';
import type { Pool } from 'pg';
import {
  signupSchema, loginSchema, profilePatchSchema, invitePreferenceSchema,
  hackathonParamsSchema, emptyObjectSchema,
} from '@teamforge/shared';
import type { Config } from '../../config.js';
import { AppError } from '../../db/errors.js';
import { validate } from '../../middleware/validate.js';
import { SlidingWindowLimiter, privateRateKey } from '../../middleware/rateLimit.js';
import type { RateLimiter } from '../../middleware/rateLimit.js';
import { createPasswords } from './password.js';
import { createSessions } from './session.js';
import { signup, profile, updateProfile } from './service.js';
import { listHackathons, getHackathon, register, updatePreference } from '../hackathons/service.js';
import { domainMutation } from '../../db/idempotency.js';
import { teamRouter } from '../teams/routes.js';
import type { TeamOptions } from '../teams/routes.js';
import { createDiscovery, discoveryRouter } from '../discovery/routes.js';
import type { Discovery } from '../discovery/routes.js';
import { teamManagementRouter } from '../teams/managementRoutes.js';

export type IdentityOptions = { pool: Pool; config: Config; limiter?: RateLimiter; publishTeamChange?: TeamOptions['publishTeamChange']; discovery?: Discovery };

export function identityRouter({ pool, config, limiter = new SlidingWindowLimiter(), publishTeamChange: externalPublish, discovery = createDiscovery() }: IdentityOptions) {
  const router = Router();
  const publishTeamChange: TeamOptions['publishTeamChange'] = async (change) => { discovery.changed(change.hackathonId); await externalPublish?.(change); };
  const passwords = createPasswords();
  const sessions = createSessions(config);
  router.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  router.post('/auth/signup', async (req, res) => {
    validate(emptyObjectSchema, req.query);
    const input = validate(signupSchema, req.body);
    limiter.reserve(privateRateKey('signup-ip', req.ip ?? 'unknown'), 20, 60 * 60_000);
    const passwordHash = await passwords.hash(input.password); // Outside any locked transaction.
    const id = await signup(pool, input, passwordHash);
    sessions.write(res, await sessions.issue(id));
    res.status(201).json({ authenticated: true });
  });
  router.post('/auth/login', async (req, res) => {
    validate(emptyObjectSchema, req.query);
    const input = validate(loginSchema, req.body);
    const releaseIp = limiter.reserve(privateRateKey('login-ip', req.ip ?? 'unknown'), 10, 15 * 60_000);
    let releaseEmail: (() => void) | undefined;
    let failedLogin = false;
    try {
      releaseEmail = limiter.reserve(privateRateKey('login-email', input.email), 10, 15 * 60_000);
      const { rows: [user] } = await pool.query<{ id: string; password_hash: string }>(
        'SELECT id, password_hash FROM users WHERE lower(email) = $1', [input.email]);
      const matches = await passwords.matches(input.password, user?.password_hash);
      if (!user || !matches) {
        failedLogin = true;
        throw new AppError('UNAUTHENTICATED', 401, 'Email or password is incorrect.');
      }
      sessions.write(res, await sessions.issue(user.id));
      res.json({ authenticated: true });
    } finally {
      if (!failedLogin) { releaseIp(); releaseEmail?.(); }
    }
  });

  router.use(async (req, res, next) => {
    const { userId, expiresAt } = await sessions.readSession(req);
    res.locals.sessionExpiresAt = expiresAt;
    if ((await pool.query('SELECT 1 FROM users WHERE id = $1', [userId])).rowCount !== 1) {
      throw new AppError('UNAUTHENTICATED', 401, 'Please sign in to continue.');
    }
    res.locals.userId = userId;
    const read = ['GET', 'HEAD'].includes(req.method);
    limiter.reserve(`${read ? 'read' : 'mutation'}:${userId}`, read ? 600 : 60, 60_000);
    next();
  });
  router.use(discoveryRouter({ pool, config, limiter }, discovery));
  router.use(teamManagementRouter({ pool, config, limiter, publishTeamChange }));
  router.post('/auth/logout', (req, res) => {
    validate(emptyObjectSchema, req.body ?? {});
    sessions.clear(res);
    res.status(204).end();
  });
  router.get('/me', async (_req, res) => res.json(await profile({ q: (sql, params) => pool.query(sql, params) }, String(res.locals.userId))));
  router.patch('/me', async (req, res) => {
    const input = validate(profilePatchSchema, req.body);
    await domainMutation(pool, req, res, async (tx) => {
      const body = await updateProfile(tx, String(res.locals.userId), input);
      tx.afterCommit(() => { for (const r of body.registrations) discovery.changed(r.hackathonId); });
      return { status: 200, body };
    });
  });
  router.get('/hackathons', async (_req, res) => res.json(await listHackathons(pool, String(res.locals.userId))));
  router.get('/hackathons/:hid', async (req, res) => {
    const { hid } = validate(hackathonParamsSchema, req.params);
    res.json(await getHackathon(pool, String(res.locals.userId), hid));
  });
  router.post('/hackathons/:hid/register', async (req, res) => {
    const { hid } = validate(hackathonParamsSchema, req.params);
    validate(emptyObjectSchema, req.body ?? {});
    await domainMutation(pool, req, res, async (tx) => {
      const body = await register(tx, String(res.locals.userId), hid);
      tx.afterCommit(() => discovery.changed(hid));
      return { status: 200, body };
    });
  });
  router.patch('/hackathons/:hid/me', async (req, res) => {
    const { hid } = validate(hackathonParamsSchema, req.params);
    const { openToInvites } = validate(invitePreferenceSchema, req.body);
    await domainMutation(pool, req, res, async (tx) => {
      const body = await updatePreference(tx, String(res.locals.userId), hid, openToInvites);
      tx.afterCommit(() => discovery.changed(hid));
      return { status: 200, body };
    });
  });
  router.use(teamRouter({ pool, config, limiter, publishTeamChange }));
  return router;
}
