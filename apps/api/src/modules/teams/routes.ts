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
    const ip = req.ip ?? 'unknown';

    // IP flood protection: allows up to 100 concurrent in-flight requests per IP,
    // accommodating 50 legitimate participants behind a single NAT in race tests without blocking.
    const releaseFlood = limiter.reserve(privateRateKey('join-flood-ip', ip), 100, 60_000);

    // Fast reject if this user or IP has already exhausted their invalid-code failure budget:
    const releaseUserCheck = limiter.reserve(`join-failed-user:${userId}`, 10, 15 * 60_000);
    releaseUserCheck();
    const releaseIpCheck = limiter.reserve(privateRateKey('join-failed-ip', ip), 40, 15 * 60_000);
    releaseIpCheck();

    try {
      await domainMutation(pool, req, res, async (tx) => ({
        status: 200,
        body: await joinTeam(tx, {
          userId, hackathonId: hid, requestId: String(res.getHeader('X-Request-Id')), publish: publishTeamChange,
        }, code),
      }));
    } catch (error) {
      if (error instanceof AppError && error.code === 'INVALID_OR_EXPIRED_CODE') {
        // Code is confirmed invalid or expired. Record failure against quotas without releasing.
        limiter.reserve(`join-failed-user:${userId}`, 10, 15 * 60_000);
        limiter.reserve(privateRateKey('join-failed-ip', ip), 40, 15 * 60_000);
      }
      throw error;
    } finally {
      releaseFlood();
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
