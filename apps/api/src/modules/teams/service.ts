import type { TeamCreate, TeamDetail, Skill, MyTeam, LeaveTeamResult } from '@teamforge/shared';
import type { Tx } from '../../db/tx.js';
import { AppError, busyError } from '../../db/errors.js';
import { inviteCode } from './invite.js';

export type TeamChange = { hackathonId: string; teamId: string; deleted: boolean };
export type TeamContext = {
  userId: string; hackathonId: string; requestId: string;
  publish?: ((change: TeamChange) => void | Promise<void>) | undefined;
};
type TeamRow = {
  id: string; name: string; description: string; looking_for: Skill[]; is_open: boolean;
  leader_id: string; leader_name: string; member_count: number; min_size: number; max_size: number;
  version: string; created_at: Date; members: TeamDetail['members'];
  invite_code: string | null; invite_expires_at: Date | null; pending_count: number | null;
};
type LockedTeam = { id: string; leader_id: string; member_count: number; max_size: number };

export async function requireParticipant(tx: Pick<Tx, 'q'>, userId: string, hackathonId: string, lock = false) {
  const sql = lock
    ? 'SELECT 1 FROM hackathon_participants WHERE hackathon_id = $1 AND user_id = $2 FOR NO KEY UPDATE'
    : 'SELECT 1 FROM hackathon_participants WHERE hackathon_id = $1 AND user_id = $2';
  if ((await tx.q(sql, [hackathonId, userId])).rowCount !== 1) {
    throw new AppError('NOT_REGISTERED', 403, 'Register for this hackathon first.');
  }
}

// One statement gives counts, membership and leader-only fields the same snapshot.
export async function readTeam(tx: Pick<Tx, 'q'>, userId: string, hackathonId: string, teamId: string | null): Promise<TeamDetail | null> {
  const { rows: [row] } = await tx.q<TeamRow>(`SELECT t.id, t.name, t.description, t.looking_for, t.is_open,
      t.leader_id, leader.display_name AS leader_name, t.member_count, t.min_size, t.max_size, t.version, t.created_at,
      CASE WHEN t.leader_id = $1 THEN t.invite_code END AS invite_code,
      CASE WHEN t.leader_id = $1 THEN t.invite_expires_at END AS invite_expires_at,
      CASE WHEN t.leader_id = $1 THEN (SELECT count(*)::integer FROM join_requests r WHERE r.team_id = t.id AND r.status = 'pending') END AS pending_count,
      (SELECT jsonb_agg(jsonb_build_object('userId', m.user_id, 'displayName', u.display_name,
        'skills', u.skills, 'utcOffsetMin', u.utc_offset_min, 'isLeader', m.user_id = t.leader_id,
        'joinedAt', to_char(m.joined_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) ORDER BY m.joined_at, m.user_id)
       FROM team_members m JOIN users u ON u.id = m.user_id WHERE m.team_id = t.id) AS members
    FROM teams t JOIN users leader ON leader.id = t.leader_id
    WHERE t.hackathon_id = $2 AND t.id = COALESCE($3::uuid,
      (SELECT team_id FROM team_members WHERE hackathon_id = $2 AND user_id = $1))`, [userId, hackathonId, teamId]);
  if (!row) return null;
  return {
    id: row.id, name: row.name, description: row.description, lookingFor: row.looking_for, isOpen: row.is_open,
    memberCount: row.member_count, minSize: row.min_size, maxSize: row.max_size,
    openSeats: row.max_size - row.member_count, ready: row.member_count >= row.min_size,
    leader: { id: row.leader_id, displayName: row.leader_name }, version: Number(row.version), createdAt: row.created_at.toISOString(),
    members: row.members,
    ...(row.invite_code !== null ? { inviteCode: row.invite_code, inviteExpiresAt: row.invite_expires_at!.toISOString(), pendingRequestCount: row.pending_count! } : {}),
  };
}

export async function myTeam(tx: Tx, userId: string, hackathonId: string): Promise<MyTeam> {
  await requireParticipant(tx, userId, hackathonId);
  const team = await readTeam(tx, userId, hackathonId, null);
  const { rows } = await tx.q<{ id: string; team_id: string; team_name: string; message: string; created_at: Date }>(
    `SELECT r.id, r.team_id, t.name AS team_name, r.message, r.created_at FROM join_requests r
     JOIN teams t ON t.id = r.team_id WHERE r.hackathon_id = $1 AND r.user_id = $2 AND r.status = 'pending'
     ORDER BY r.created_at, r.id`, [hackathonId, userId]);
  return { team, pendingRequests: rows.map((row) => ({ id: row.id, teamId: row.team_id, teamName: row.team_name, message: row.message, createdAt: row.created_at.toISOString() })) };
}

async function membership(tx: Tx, context: TeamContext) {
  return (await tx.q<{ team_id: string }>('SELECT team_id FROM team_members WHERE hackathon_id = $1 AND user_id = $2', [context.hackathonId, context.userId])).rows[0];
}
async function audit(tx: Tx, context: TeamContext, teamId: string, action: string, target: string | null, details: Record<string, unknown> = {}) {
  await tx.q(`INSERT INTO audit_log (hackathon_id, team_id, actor_id, target_user_id, action, details, request_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7)`, [context.hackathonId, teamId, context.userId, target, action, details, context.requestId]);
}
async function cancelRequests(tx: Tx, context: TeamContext) {
  // Only request rows are updated. Acquiring another team's lock here would invert the hierarchy.
  await tx.q(`WITH cancelled AS (
    UPDATE join_requests SET status = 'cancelled', decided_at = clock_timestamp(), decided_by = $2
    WHERE hackathon_id = $1 AND user_id = $2 AND status = 'pending' RETURNING id, team_id
  ) INSERT INTO audit_log (hackathon_id, team_id, actor_id, target_user_id, action, details, request_id)
    SELECT $1, team_id, $2, $2, 'request.cancelled', jsonb_build_object('requestId', id, 'reason', 'joined_team'), $3 FROM cancelled`,
  [context.hackathonId, context.userId, context.requestId]);
}
function changed(tx: Tx, context: TeamContext, teamId: string, deleted = false) {
  if (context.publish) tx.afterCommit(() => context.publish!({ hackathonId: context.hackathonId, teamId, deleted }));
}

export async function createTeam(tx: Tx, context: TeamContext, input: TeamCreate, ttlHours: number) {
  await requireParticipant(tx, context.userId, context.hackathonId, true);
  if (await membership(tx, context)) throw new AppError('ALREADY_IN_TEAM', 409, 'You already belong to a team in this hackathon.');
  let teamId: string | undefined;
  for (let attempt = 0; attempt < 5; attempt++) {
    const { rows: [row] } = await tx.q<{ id: string }>(`INSERT INTO teams
      (hackathon_id, name, description, looking_for, is_open, leader_id, min_size, max_size, invite_code, invite_expires_at)
      SELECT id, $2, $3, $4, $5, $6, min_team_size, max_team_size, $7, clock_timestamp() + ($8 * interval '1 hour')
      FROM hackathons WHERE id = $1 ON CONFLICT (invite_code) DO NOTHING RETURNING id`,
    [context.hackathonId, input.name, input.description, input.lookingFor, input.isOpen, context.userId, inviteCode(), ttlHours]);
    if (row) { teamId = row.id; break; }
  }
  if (!teamId) throw busyError();
  await tx.q('INSERT INTO team_members (team_id, hackathon_id, user_id) VALUES ($1,$2,$3)', [teamId, context.hackathonId, context.userId]);
  await cancelRequests(tx, context);
  await audit(tx, context, teamId, 'team.created', context.userId);
  const team = (await readTeam(tx, context.userId, context.hackathonId, teamId))!;
  changed(tx, context, teamId);
  return { team };
}

export function invalidCode() { return new AppError('INVALID_OR_EXPIRED_CODE', 404, 'This invite code is invalid or expired.'); }
export async function joinTeam(tx: Tx, context: TeamContext, code: string) {
  await requireParticipant(tx, context.userId, context.hackathonId, true);
  const { rows: [candidate] } = await tx.q<{ id: string }>('SELECT id FROM teams WHERE hackathon_id = $1 AND invite_code = $2', [context.hackathonId, code]);
  if (!candidate) throw invalidCode();
  const { rows: [locked] } = await tx.q<LockedTeam>(
    'SELECT id, leader_id, member_count, max_size FROM teams WHERE hackathon_id = $1 AND id = $2 FOR UPDATE', [context.hackathonId, candidate.id]);
  if (!locked) throw invalidCode();
  // This must remain a NEW statement after FOR UPDATE has returned. A timestamp
  // evaluated before waiting for the lock could admit a code that expired in the wait.
  const valid = await tx.q('SELECT 1 FROM teams WHERE id = $1 AND invite_code = $2 AND invite_expires_at > clock_timestamp()', [locked.id, code]);
  if (valid.rowCount !== 1) throw invalidCode();
  const existing = await membership(tx, context);
  if (existing && existing.team_id !== locked.id) throw new AppError('ALREADY_IN_TEAM', 409, 'You already belong to a team in this hackathon.');
  if (existing) return { team: (await readTeam(tx, context.userId, context.hackathonId, locked.id))!, alreadyMember: true };
  if (locked.member_count >= locked.max_size) throw new AppError('TEAM_FULL', 409, 'Someone took the last seat. This team is full.');
  await tx.q('INSERT INTO team_members (team_id, hackathon_id, user_id) VALUES ($1,$2,$3)', [locked.id, context.hackathonId, context.userId]);
  await audit(tx, context, locked.id, 'member.joined', context.userId);
  await cancelRequests(tx, context);
  const team = (await readTeam(tx, context.userId, context.hackathonId, locked.id))!;
  changed(tx, context, locked.id);
  return { team, alreadyMember: false };
}

export async function leaveTeam(tx: Tx, context: TeamContext, teamId: string): Promise<LeaveTeamResult> {
  await requireParticipant(tx, context.userId, context.hackathonId, true);
  const { rows: [team] } = await tx.q<LockedTeam>(
    'SELECT id, leader_id, member_count, max_size FROM teams WHERE hackathon_id = $1 AND id = $2 FOR UPDATE', [context.hackathonId, teamId]);
  if (!team || (await membership(tx, context))?.team_id !== team.id) throw new AppError('NOT_A_MEMBER', 404, 'You are not a member of this team.');
  await tx.q('DELETE FROM team_members WHERE team_id = $1 AND user_id = $2', [teamId, context.userId]);
  await audit(tx, context, teamId, 'member.left', context.userId);
  if (team.member_count === 1) {
    await tx.q('DELETE FROM teams WHERE id = $1 AND member_count = 0', [teamId]);
    await audit(tx, context, teamId, 'team.deleted', null, { reason: 'last_member_left' });
  } else if (team.leader_id === context.userId) {
    const { rows: [successor] } = await tx.q<{ user_id: string }>(
      'SELECT user_id FROM team_members WHERE team_id = $1 ORDER BY joined_at, user_id LIMIT 1', [teamId]);
    if (!successor) throw new Error('A non-empty team must have a successor.');
    await tx.q('UPDATE teams SET leader_id = $2 WHERE id = $1', [teamId, successor.user_id]);
    await audit(tx, context, teamId, 'leader.changed', successor.user_id, { previousLeaderId: context.userId });
  }
  changed(tx, context, teamId, team.member_count === 1);
  return { left: true, teamDeleted: team.member_count === 1 };
}
