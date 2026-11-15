import { Router } from 'express';
import { boardQuerySchema, emptyObjectSchema, hackathonParamsSchema, teamParamsSchema } from '@teamforge/shared';
import { validate } from '../../middleware/validate.js';
import { withTx } from '../../db/tx.js';
import { requireParticipant } from '../teams/service.js';
import type { TeamOptions } from '../teams/routes.js';
import { BoardCache } from './cache.js';
import { StreamHub } from './stream.js';
import { board, parseBoardCursor, suggestions } from './service.js';

export function createDiscovery() {
  const cache = new BoardCache(); const hub = new StreamHub();
  return { cache, hub, changed(hid: string) { cache.invalidate(hid); hub.changed(hid); }, close() { hub.close(); } };
}
export type Discovery = ReturnType<typeof createDiscovery>;
export function discoveryRouter({ pool, limiter }: TeamOptions, discovery: Discovery) {
  const router = Router();
  router.get('/hackathons/:hid/teams', async (req, res) => {
    const { hid } = validate(hackathonParamsSchema, req.params);
    const query = validate(boardQuerySchema, req.query); parseBoardCursor(query);
    // Authorization is never cached, including conditional requests and hits.
    await withTx(pool, (tx) => requireParticipant(tx, String(res.locals.userId), hid));
    // Release the authorization checkout before awaiting a shared cache load.
    const value = await discovery.cache.get(hid, query, () => withTx(pool, (tx) => board(tx, hid, query)));
    res.set({ 'Content-Type': 'application/json', 'Cache-Control': 'private, no-cache', ETag: value.etag });
    res.vary('Accept-Encoding');
    if (req.fresh) { res.status(304).end(); return; }
    if (req.acceptsEncodings('gzip')) { res.setHeader('Content-Encoding', 'gzip'); res.send(value.gzip); }
    else res.send(value.json);
  });
  router.get('/hackathons/:hid/teams/:tid/suggestions', async (req, res) => {
    const { hid, tid } = validate(teamParamsSchema, req.params); validate(emptyObjectSchema, req.query);
    res.json(await withTx(pool, (tx) => suggestions(tx, { userId: String(res.locals.userId), hackathonId: hid, requestId: String(res.getHeader('X-Request-Id')) }, tid)));
  });
  router.get('/hackathons/:hid/stream', async (req, res) => {
    const { hid } = validate(hackathonParamsSchema, req.params); validate(emptyObjectSchema, req.query);
    const userId = String(res.locals.userId);
    await withTx(pool, (tx) => requireParticipant(tx, userId, hid));
    if (req.method === 'HEAD') { res.status(200).end(); return; }
    limiter.reserve(`stream:${userId}`, 30, 60_000);
    discovery.hub.connect(res, userId, hid, Number(res.locals.sessionExpiresAt));
  });
  return router;
}
