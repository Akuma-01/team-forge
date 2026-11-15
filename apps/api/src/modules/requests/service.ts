import { z } from 'zod';
import type { InboxRequest, JoinRequest, Page, PageQuery, RequestCreate, RequestResult, Skill } from '@teamforge/shared';
import type { Tx } from '../../db/tx.js';
import type { Result } from '../../db/idempotency.js';
import { AppError } from '../../db/errors.js';
import { decodeCursor, encodeCursor } from '../../middleware/pagination.js';
import { audit, cancelRequests, changed, membership, requireParticipant } from '../teams/service.js';
import type { TeamContext } from '../teams/service.js';
import { lockTeam, requireLeader } from '../teams/management.js';

type RequestRow = { id: string; team_id: string; user_id: string; message: string; status: JoinRequest['status'];
  created_at: Date; decided_at: Date | null; decided_by: string | null };
function dto(row: RequestRow): JoinRequest {
  return { id: row.id, teamId: row.team_id, userId: row.user_id, message: row.message, status: row.status,
    createdAt: row.created_at.toISOString(), decidedAt: row.decided_at?.toISOString() ?? null, decidedBy: row.decided_by };
}
function notPending() { return new AppError('REQUEST_NOT_PENDING', 409, 'This application is no longer pending.'); }
async function readRequest(tx: Tx, hackathonId: string, requestId: string, ownerId: string | null = null) {
  const row = (await tx.q<RequestRow>(`SELECT id, team_id, user_id, message, status, created_at, decided_at, decided_by
    FROM join_requests WHERE hackathon_id=$1 AND id=$2 AND ($3::uuid IS NULL OR user_id=$3)`, [hackathonId, requestId, ownerId])).rows[0];
  if (!row) throw new AppError('NOT_FOUND', 404, 'Application not found.');
  return row;
}
async function pendingRequest(tx: Tx, hackathonId: string, teamId: string, userId: string) {
  return (await tx.q<RequestRow>(`SELECT id, team_id, user_id, message, status, created_at, decided_at, decided_by
    FROM join_requests WHERE hackathon_id=$1 AND team_id=$2 AND user_id=$3 AND status='pending'`, [hackathonId, teamId, userId])).rows[0];
}
export async function applyToTeam(tx: Tx, context: TeamContext, teamId: string, input: RequestCreate): Promise<Result<RequestResult>> {
  await requireParticipant(tx, context.userId, context.hackathonId, true);
  if (await membership(tx, context)) throw new AppError('ALREADY_IN_TEAM', 409, 'You already belong to a team in this hackathon.');
  const team = await lockTeam(tx, context, teamId);
  if (!team.is_open) throw new AppError('TEAM_CLOSED', 409, 'This team is not accepting applications.');
  if (team.member_count >= team.max_size) throw new AppError('TEAM_FULL', 409, 'This team has no open seats.');
  const previous = await pendingRequest(tx, context.hackathonId, teamId, context.userId);
  if (previous) return { status: 200, body: { request: dto(previous) } };
  const count = (await tx.q<{ count: number }>(`SELECT count(*)::integer AS count FROM join_requests
    WHERE hackathon_id=$1 AND user_id=$2 AND status='pending'`, [context.hackathonId, context.userId])).rows[0]!.count;
  if (count >= 5) throw new AppError('TOO_MANY_PENDING', 409, 'You can have at most five pending applications.');
  const inserted = (await tx.q<RequestRow>(`INSERT INTO join_requests (hackathon_id,team_id,user_id,message)
    VALUES ($1,$2,$3,$4) ON CONFLICT (team_id,user_id) WHERE status='pending' DO NOTHING RETURNING *`,
  [context.hackathonId, teamId, context.userId, input.message])).rows[0];
  if (!inserted) {
    const existing = await pendingRequest(tx, context.hackathonId, teamId, context.userId);
    if (!existing) throw notPending();
    return { status: 200, body: { request: dto(existing) } };
  }
  await audit(tx, context, teamId, 'request.created', context.userId, { requestId: inserted.id, teamId });
  changed(tx, context, teamId);
  return { status: 201, body: { request: dto(inserted) } };
}

async function decide(tx: Tx, context: TeamContext, request: RequestRow, status: 'accepted' | 'declined') {
  const updated = (await tx.q<RequestRow>(`UPDATE join_requests SET status=$3, decided_at=clock_timestamp(), decided_by=$4
    WHERE hackathon_id=$1 AND id=$2 AND status='pending' RETURNING *`, [context.hackathonId, request.id, status, context.userId])).rows[0];
  if (!updated) throw notPending();
  await audit(tx, context, request.team_id, `request.${status}`, request.user_id, { requestId: request.id });
  return updated;
}
export async function acceptRequest(tx: Tx, context: TeamContext, requestId: string): Promise<RequestResult> {
  await requireParticipant(tx, context.userId, context.hackathonId);
  const candidate = await readRequest(tx, context.hackathonId, requestId);
  await requireParticipant(tx, candidate.user_id, context.hackathonId, true);
  const team = await lockTeam(tx, context, candidate.team_id);
  requireLeader(team, context.userId);
  const request = await readRequest(tx, context.hackathonId, requestId);
  if (request.status !== 'pending') throw notPending();
  if (await membership(tx, { ...context, userId: request.user_id })) throw new AppError('ALREADY_IN_TEAM', 409, 'This applicant already belongs to a team.');
  if (team.member_count >= team.max_size) throw new AppError('TEAM_FULL', 409, 'This team has no open seats.');
  // Withdrawal can win after the re-read. A conditional transition must succeed
  // before membership is inserted; all changes still commit or roll back together.
  const updated = await decide(tx, context, request, 'accepted');
  await tx.q('INSERT INTO team_members (team_id,hackathon_id,user_id) VALUES ($1,$2,$3)', [team.id, context.hackathonId, request.user_id]);
  await audit(tx, context, team.id, 'member.joined', request.user_id, { via: 'request', requestId });
  await cancelRequests(tx, context, request.user_id);
  changed(tx, context, team.id);
  return { request: dto(updated) };
}
export async function declineRequest(tx: Tx, context: TeamContext, requestId: string): Promise<RequestResult> {
  await requireParticipant(tx, context.userId, context.hackathonId);
  const request = await readRequest(tx, context.hackathonId, requestId);
  requireLeader(await lockTeam(tx, context, request.team_id), context.userId);
  const updated = await decide(tx, context, request, 'declined');
  changed(tx, context, request.team_id);
  return { request: dto(updated) };
}
export async function withdrawRequest(tx: Tx, context: TeamContext, requestId: string): Promise<RequestResult> {
  await requireParticipant(tx, context.userId, context.hackathonId);
  const request = await readRequest(tx, context.hackathonId, requestId, context.userId);
  // No later team/participant lock: cancellation can safely race a decision or
  // joining elsewhere. The UPDATE rechecks pending after any row-lock wait.
  const updated = (await tx.q<RequestRow>(`WITH cancelled AS (
    UPDATE join_requests SET status='cancelled', decided_at=clock_timestamp(), decided_by=$3
    WHERE hackathon_id=$1 AND id=$2 AND user_id=$3 AND status='pending' RETURNING *
  ), logged AS (
    INSERT INTO audit_log (hackathon_id,team_id,actor_id,target_user_id,action,details,request_id)
    SELECT hackathon_id,team_id,$3,$3,'request.cancelled',jsonb_build_object('requestId',id,'reason','withdrawn'),$4 FROM cancelled
  ) SELECT * FROM cancelled`, [context.hackathonId, requestId, context.userId, context.requestId])).rows[0];
  if (!updated) throw notPending();
  changed(tx, context, request.team_id);
  return { request: dto(updated) };
}

const inboxCursor = z.object({
  // Cursors retain PostgreSQL microseconds. Year zero is accepted by ISO-8601
  // validators but not PostgreSQL's timestamp input, so reject it before SQL.
  createdAt: z.string().datetime({ precision: 6 }).refine((value) => !value.startsWith('0000-')),
  id: z.string().uuid(),
}).strict();
export async function requestInbox(tx: Tx, context: TeamContext, teamId: string, query: PageQuery): Promise<Page<InboxRequest>> {
  const cursor = query.cursor ? decodeCursor(inboxCursor, query.cursor) : null;
  await requireParticipant(tx, context.userId, context.hackathonId);
  requireLeader(await lockTeam(tx, context, teamId, true), context.userId);
  const { rows } = await tx.q<RequestRow & { display_name: string; skills: Skill[]; utc_offset_min: number; cursor_time: string }>(
    `SELECT r.id, r.team_id, r.user_id, r.message, r.status, r.created_at, r.decided_at, r.decided_by,
      u.display_name, u.skills, u.utc_offset_min,
      to_char(r.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_time
     FROM join_requests r JOIN users u ON u.id=r.user_id
     WHERE r.hackathon_id=$1 AND r.team_id=$2 AND r.status='pending'
       AND ($3::timestamptz IS NULL OR (r.created_at,r.id)<($3::timestamptz,$4::uuid))
     ORDER BY r.created_at DESC,r.id DESC LIMIT $5`, [context.hackathonId, teamId, cursor?.createdAt ?? null, cursor?.id ?? null, query.limit + 1]);
  const page = rows.slice(0, query.limit);
  const last = page.at(-1);
  return { items: page.map((row) => ({ ...dto(row), applicant: { displayName: row.display_name, skills: row.skills, utcOffsetMin: row.utc_offset_min } })),
    nextCursor: rows.length > query.limit ? encodeCursor({ createdAt: last!.cursor_time, id: last!.id }) : null };
}
