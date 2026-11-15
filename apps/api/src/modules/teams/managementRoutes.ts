import { Router } from 'express';
import type { Response } from 'express';
import { emptyObjectSchema, memberParamsSchema, pageQuerySchema, requestCreateSchema, requestParamsSchema, teamParamsSchema, teamPatchSchema } from '@teamforge/shared';
import { domainMutation } from '../../db/idempotency.js';
import { withTx } from '../../db/tx.js';
import { validate } from '../../middleware/validate.js';
import { acceptRequest, applyToTeam, declineRequest, requestInbox, withdrawRequest } from '../requests/service.js';
import { readInvite, removeMember, rotateInvite, teamAudit, updateTeam } from './management.js';
import type { TeamOptions } from './routes.js';
import type { TeamContext } from './service.js';

// Mounted after authentication, before the existing routes' no-query guard.
export function teamManagementRouter({ pool, config, limiter, publishTeamChange }: TeamOptions) {
  const router = Router();
  const context = (res: Response, hackathonId: string): TeamContext => ({
    userId: String(res.locals.userId), hackathonId, requestId: String(res.getHeader('X-Request-Id')), publish: publishTeamChange,
  });
  router.get('/hackathons/:hid/teams/:tid/requests', async (req, res) => {
    const { hid, tid } = validate(teamParamsSchema, req.params);
    const query = validate(pageQuerySchema, req.query);
    res.json(await withTx(pool, (tx) => requestInbox(tx, context(res, hid), tid, query)));
  });
  router.get('/hackathons/:hid/teams/:tid/audit', async (req, res) => {
    const { hid, tid } = validate(teamParamsSchema, req.params);
    const query = validate(pageQuerySchema, req.query);
    res.json(await withTx(pool, (tx) => teamAudit(tx, context(res, hid), tid, query)));
  });
  // All remaining authenticated routes still reject unexpected query strings.
  router.use((req, _res, next) => { validate(emptyObjectSchema, req.query); next(); });
  router.get('/hackathons/:hid/teams/:tid/invite', async (req, res) => {
    const { hid, tid } = validate(teamParamsSchema, req.params);
    res.json(await withTx(pool, (tx) => readInvite(tx, context(res, hid), tid)));
  });
  router.post('/hackathons/:hid/teams/:tid/requests', async (req, res) => {
    const { hid, tid } = validate(teamParamsSchema, req.params);
    const input = validate(requestCreateSchema, req.body);
    limiter.reserve(`applications:${String(res.locals.userId)}`, 20, 60_000);
    await domainMutation(pool, req, res, (tx) => applyToTeam(tx, context(res, hid), tid, input));
  });
  for (const [action, decide] of [['accept', acceptRequest], ['decline', declineRequest]] as const) {
    router.post(`/hackathons/:hid/requests/:rid/${action}`, async (req, res) => {
      const { hid, rid } = validate(requestParamsSchema, req.params);
      validate(emptyObjectSchema, req.body ?? {});
      await domainMutation(pool, req, res, async (tx) => ({ status: 200, body: await decide(tx, context(res, hid), rid) }));
    });
  }
  router.delete('/hackathons/:hid/requests/:rid', async (req, res) => {
    const { hid, rid } = validate(requestParamsSchema, req.params);
    validate(emptyObjectSchema, req.body ?? {});
    await domainMutation(pool, req, res, async (tx) => ({ status: 200, body: await withdrawRequest(tx, context(res, hid), rid) }));
  });
  router.patch('/hackathons/:hid/teams/:tid', async (req, res) => {
    const { hid, tid } = validate(teamParamsSchema, req.params);
    const input = validate(teamPatchSchema, req.body);
    await domainMutation(pool, req, res, async (tx) => ({ status: 200, body: await updateTeam(tx, context(res, hid), tid, input) }));
  });
  router.post('/hackathons/:hid/teams/:tid/invite', async (req, res) => {
    const { hid, tid } = validate(teamParamsSchema, req.params);
    validate(emptyObjectSchema, req.body ?? {});
    await domainMutation(pool, req, res, async (tx) => ({ status: 200, body: await rotateInvite(tx, context(res, hid), tid, config.INVITE_TTL_HOURS) }));
  });
  router.delete('/hackathons/:hid/teams/:tid/members/:uid', async (req, res) => {
    const { hid, tid, uid } = validate(memberParamsSchema, req.params);
    validate(emptyObjectSchema, req.body ?? {});
    await domainMutation(pool, req, res, async (tx) => ({ status: 200, body: await removeMember(tx, context(res, hid), tid, uid, config.INVITE_TTL_HOURS) }));
  });
  return router;
}
