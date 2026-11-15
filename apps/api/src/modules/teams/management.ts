import type { AuditEntry, InviteResult, Page, PageQuery, TeamPatch } from '@teamforge/shared';
import { z } from 'zod';
import type { Tx } from '../../db/tx.js';
import { AppError, busyError, pgDiagnostic } from '../../db/errors.js';
import { decodeCursor, encodeCursor } from '../../middleware/pagination.js';
import { inviteCode } from './invite.js';
import { audit, changed, membership, readTeam, requireParticipant } from './service.js';
import type { TeamContext } from './service.js';

type ManagedTeam = { id: string; leader_id: string; member_count: number; max_size: number; is_open: boolean };
export async function lockTeam(tx: Tx, context: TeamContext, teamId: string, readOnly = false) {
  const sql = readOnly
    ? 'SELECT id, leader_id, member_count, max_size, is_open FROM teams WHERE hackathon_id=$1 AND id=$2 FOR SHARE'
    : 'SELECT id, leader_id, member_count, max_size, is_open FROM teams WHERE hackathon_id=$1 AND id=$2 FOR UPDATE';
  const team = (await tx.q<ManagedTeam>(sql, [context.hackathonId, teamId])).rows[0];
  if (!team) throw new AppError('TEAM_NOT_FOUND', 404, 'Team not found.');
  return team;
}
export function requireLeader(team: ManagedTeam, userId: string) {
  if (team.leader_id !== userId) throw new AppError('NOT_LEADER', 403, 'Only the current team leader can do this.');
}

async function currentInvite(tx: Tx, teamId: string): Promise<InviteResult> {
  const row = (await tx.q<{ invite_code: string; invite_expires_at: Date }>(
    'SELECT invite_code, invite_expires_at FROM teams WHERE id=$1', [teamId])).rows[0]!;
  return { inviteCode: row.invite_code, inviteExpiresAt: row.invite_expires_at.toISOString() };
}
export async function readInvite(tx: Tx, context: TeamContext, teamId: string) {
  await requireParticipant(tx, context.userId, context.hackathonId);
  requireLeader(await lockTeam(tx, context, teamId, true), context.userId);
  return currentInvite(tx, teamId);
}

async function replaceInvite(tx: Tx, context: TeamContext, teamId: string, ttlHours: number, reason: 'manual' | 'member_removed') {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      // Exclude the existing code and already-taken proposals. A concurrent
      // unique-index collision aborts the whole mutation and returns BUSY;
      // the caller can retry its same intent, including a rolled-back removal.
      const result = await tx.q(`UPDATE teams SET invite_code=$2,
        invite_expires_at=clock_timestamp()+($3 * interval '1 hour')
        WHERE id=$1 AND invite_code<>$2 AND NOT EXISTS (SELECT 1 FROM teams WHERE invite_code=$2)`,
      [teamId, inviteCode(), ttlHours]);
      if (result.rowCount !== 1) continue;
      await audit(tx, context, teamId, 'invite.rotated', null, { reason });
      return currentInvite(tx, teamId);
    } catch (error) {
      const diagnostic = pgDiagnostic(error);
      if (diagnostic.code === '23505' && diagnostic.constraint === 'teams_invite_code_uq') throw busyError();
      throw error;
    }
  }
  throw busyError();
}
export async function rotateInvite(tx: Tx, context: TeamContext, teamId: string, ttlHours: number) {
  await requireParticipant(tx, context.userId, context.hackathonId);
  requireLeader(await lockTeam(tx, context, teamId), context.userId);
  const invite = await replaceInvite(tx, context, teamId, ttlHours, 'manual');
  changed(tx, context, teamId);
  return invite;
}
export async function removeMember(tx: Tx, context: TeamContext, teamId: string, targetId: string, ttlHours: number) {
  await requireParticipant(tx, context.userId, context.hackathonId);
  // Only the target participant is locked; never acquire the actor afterward.
  await tx.q('SELECT 1 FROM hackathon_participants WHERE hackathon_id=$1 AND user_id=$2 FOR NO KEY UPDATE', [context.hackathonId, targetId]);
  const team = await lockTeam(tx, context, teamId);
  requireLeader(team, context.userId);
  if (targetId === team.leader_id) throw new AppError('CANNOT_REMOVE_LEADER', 409, 'Use Leave team to transfer leadership.');
  const removed = await tx.q('DELETE FROM team_members WHERE team_id=$1 AND user_id=$2 RETURNING user_id', [teamId, targetId]);
  if (!removed.rowCount) throw new AppError('NOT_A_MEMBER', 404, 'This person is not a member of this team.');
  await audit(tx, context, teamId, 'member.removed', targetId);
  await replaceInvite(tx, context, teamId, ttlHours, 'member_removed');
  changed(tx, context, teamId);
  return { removed: true as const };
}
export async function updateTeam(tx: Tx, context: TeamContext, teamId: string, input: TeamPatch) {
  await requireParticipant(tx, context.userId, context.hackathonId);
  requireLeader(await lockTeam(tx, context, teamId), context.userId);
  await tx.q(`UPDATE teams SET name=COALESCE($2,name), description=COALESCE($3,description),
    looking_for=COALESCE($4,looking_for), is_open=COALESCE($5,is_open) WHERE id=$1`,
  [teamId, input.name ?? null, input.description ?? null, input.lookingFor ?? null, input.isOpen ?? null]);
  await audit(tx, context, teamId, 'team.updated', null, { changed: Object.keys(input).sort() });
  changed(tx, context, teamId);
  return { team: (await readTeam(tx, context.userId, context.hackathonId, teamId))! };
}

const auditCursor = z.object({ id: z.string().regex(/^[1-9]\d{0,18}$/).refine((id) => BigInt(id) <= 9223372036854775807n) }).strict();
export async function teamAudit(tx: Tx, context: TeamContext, teamId: string, query: PageQuery): Promise<Page<AuditEntry>> {
  const cursor = query.cursor ? decodeCursor(auditCursor, query.cursor) : null;
  await requireParticipant(tx, context.userId, context.hackathonId);
  // Holding a read lock keeps membership authorization valid through the page
  // query. Deleted teams have no current members: retained history stays private.
  await lockTeam(tx, context, teamId, true);
  if ((await membership(tx, context))?.team_id !== teamId) throw new AppError('NOT_A_MEMBER', 404, 'Only current members can read this team history.');
  const { rows } = await tx.q<{ id: string; team_id: string; actor_id: string | null; target_user_id: string | null;
    action: string; details: Record<string, unknown>; request_id: string | null; created_at: Date }>(
    `SELECT id, team_id, actor_id, target_user_id, action, details, request_id, created_at FROM audit_log
     WHERE hackathon_id=$1 AND team_id=$2 AND ($3::bigint IS NULL OR id<$3)
     ORDER BY id DESC LIMIT $4`, [context.hackathonId, teamId, cursor?.id ?? null, query.limit + 1]);
  const items = rows.slice(0, query.limit).map((row) => ({ id: row.id, teamId: row.team_id, actorId: row.actor_id,
    targetUserId: row.target_user_id, action: row.action, details: row.details, requestId: row.request_id, createdAt: row.created_at.toISOString() }));
  return { items, nextCursor: rows.length > query.limit ? encodeCursor({ id: items.at(-1)!.id }) : null };
}
