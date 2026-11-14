import { Router } from 'express';
import type { Pool } from 'pg';
import { emptyObjectSchema, hackathonParamsSchema, joinCodeSchema, teamCreateSchema, teamParamsSchema } from '@teamforge/shared';
import type { Config } from '../../config.js';
import { AppError } from '../../db/errors.js';
import { domainMutation } from '../../db/idempotency.js';
import { withTx } from '../../db/tx.js';
import { privateRateKey } from '../../middleware/rateLimit.js';
import type { RateLimiter } from '../../middleware/rateLimit.js';
import { validate } from '../../middleware/validate.js';
import { createTeam, joinTeam, leaveTeam, myTeam, readTeam, requireParticipant } from './service.js';
import type { TeamChange } from './service.js';

export type TeamOptions = { pool: Pool; config: Config; limiter: RateLimiter; publishTeamChange?: ((change: TeamChange) => void | Promise<void>) | undefined };
// Mounted AFTER the identity router's authentication and user-rate middleware.
export function teamRouter({ pool, config, limiter, publishTeamChange }: TeamOptions) {
  const router = Router();
  router.get('/hackathons/:hid/me/team', async (req, res) => {
    const { hid } = validate(hackathonParamsSchema, req.params);
    res.json(await withTx(pool, (tx) => myTeam(tx, String(res.locals.userId), hid)));
  });
  router.post('/hackathons/:hid/teams', async (req, res) => {
    const { hid } = validate(hackathonParamsSchema, req.params);
    const input = validate(teamCreateSchema, req.body);
    await domainMutation(pool, req, res, async (tx) => ({ status: 201, body: await createTeam(tx, {
      userId: String(res.locals.userId), hackathonId: hid, requestId: String(res.getHeader('X-Request-Id')), publish: publishTeamChange,
    }, input, config.INVITE_TTL_HOURS) }));
  });
  router.post('/hackathons/:hid/teams/join-by-code', async (req, res) => {
    const { hid } = validate(hackathonParamsSchema, req.params);
    const { code } = validate(joinCodeSchema, req.body);
    const userId = String(res.locals.userId);
    const releaseUser = limiter.reserve(`join-failed-user:${userId}`, 10, 15 * 60_000);
    let releaseIp: (() => void) | undefined;
    let failedCode = false;
    try {
      releaseIp = limiter.reserve(privateRateKey('join-failed-ip', req.ip ?? 'unknown'), 40, 15 * 60_000);
      await domainMutation(pool, req, res, async (tx) => ({ status: 200, body: await joinTeam(tx, {
        userId, hackathonId: hid, requestId: String(res.getHeader('X-Request-Id')), publish: publishTeamChange,
      }, code) }));
    } catch (error) {
      failedCode = error instanceof AppError && error.code === 'INVALID_OR_EXPIRED_CODE';
      throw error;
    } finally {
      if (!failedCode) { releaseUser(); releaseIp?.(); }
    }
  });
  router.get('/hackathons/:hid/teams/:tid', async (req, res) => {
    const { hid, tid } = validate(teamParamsSchema, req.params);
    const userId = String(res.locals.userId);
    const team = await withTx(pool, async (tx) => {
      await requireParticipant(tx, userId, hid);
      return readTeam(tx, userId, hid, tid);
    });
    if (!team) throw new AppError('TEAM_NOT_FOUND', 404, 'Team not found.');
    res.json(team);
  });
  router.post('/hackathons/:hid/teams/:tid/leave', async (req, res) => {
    const { hid, tid } = validate(teamParamsSchema, req.params);
    validate(emptyObjectSchema, req.body ?? {});
    await domainMutation(pool, req, res, async (tx) => ({ status: 200, body: await leaveTeam(tx, {
      userId: String(res.locals.userId), hackathonId: hid, requestId: String(res.getHeader('X-Request-Id')), publish: publishTeamChange,
    }, tid) }));
  });
  return router;
}
