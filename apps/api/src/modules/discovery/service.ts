import { z } from 'zod';
import type { BoardQuery, BoardTeam, Page, Skill, Suggestions } from '@teamforge/shared';
import type { Tx } from '../../db/tx.js';
import { AppError } from '../../db/errors.js';
import { decodeCursor, encodeCursor } from '../../middleware/pagination.js';
import { membership, requireParticipant } from '../teams/service.js';
import type { TeamContext } from '../teams/service.js';
import { lockTeam } from '../teams/management.js';
import { median, scoreCandidate, scoring } from './scoring.js';

const boardCursor = z.object({ createdAt: z.string().datetime({ precision: 6 }).refine((s) => !s.startsWith('0000-')), id: z.string().uuid() }).strict();
export function parseBoardCursor(query: BoardQuery) { return query.cursor ? decodeCursor(boardCursor, query.cursor) : null; }
export async function board(tx: Pick<Tx, 'q'>, hid: string, query: BoardQuery): Promise<Page<BoardTeam>> {
  const cursor = parseBoardCursor(query);
  const escaped = query.q.replace(/[\\%_]/g, (s) => `\\${s}`);
  const { rows } = await tx.q<{ id: string; name: string; description: string; looking_for: Skill[]; member_count: number;
    min_size: number; max_size: number; version: string; created_at: Date; cursor_time: string; leader_id: string; leader_name: string }>(
    `SELECT t.id,t.name,t.description,t.looking_for,t.member_count,t.min_size,t.max_size,t.version,t.created_at,
       to_char(t.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_time,
       t.leader_id,u.display_name AS leader_name
     FROM teams t JOIN users u ON u.id=t.leader_id
     WHERE t.hackathon_id=$1 AND t.is_open AND t.member_count<t.max_size
       AND ($2::text IS NULL OR t.looking_for @> ARRAY[$2]::text[])
       AND ($3='' OR t.name ILIKE '%' || $3 || '%' ESCAPE '\\')
       AND ($4::timestamptz IS NULL OR (t.created_at,t.id)<($4::timestamptz,$5::uuid))
     ORDER BY t.created_at DESC,t.id DESC LIMIT $6`, [hid, query.needs ?? null, escaped, cursor?.createdAt ?? null, cursor?.id ?? null, query.limit + 1]);
  const page = rows.slice(0, query.limit); const last = page.at(-1);
  return { items: page.map((r) => ({ id: r.id, name: r.name, description: r.description, lookingFor: r.looking_for,
    memberCount: r.member_count, minSize: r.min_size, maxSize: r.max_size, openSeats: r.max_size - r.member_count,
    ready: r.member_count >= r.min_size, leader: { id: r.leader_id, displayName: r.leader_name }, version: Number(r.version), createdAt: r.created_at.toISOString() })),
  nextCursor: rows.length > query.limit ? encodeCursor({ createdAt: last!.cursor_time, id: last!.id }) : null };
}
export async function suggestions(tx: Tx, context: TeamContext, teamId: string): Promise<Suggestions> {
  await requireParticipant(tx, context.userId, context.hackathonId);
  await lockTeam(tx, context, teamId, true);
  if ((await membership(tx, context))?.team_id !== teamId) throw new AppError('NOT_A_MEMBER', 404, 'Only current members can see suggestions.');
  const needs = (await tx.q<{ looking_for: Skill[] }>('SELECT looking_for FROM teams WHERE id=$1', [teamId])).rows[0]!.looking_for;
  const members = (await tx.q<{ skills: Skill[]; utc_offset_min: number }>(
    'SELECT u.skills,u.utc_offset_min FROM team_members m JOIN users u ON u.id=m.user_id WHERE m.team_id=$1', [teamId])).rows;
  const teamSkills = [...new Set(members.flatMap((r) => r.skills))]; const reference = median(members.map((r) => r.utc_offset_min));
  const candidates = (await tx.q<{ id: string; display_name: string; skills: Skill[]; utc_offset_min: number }>(
    `SELECT u.id,u.display_name,u.skills,u.utc_offset_min FROM hackathon_participants p JOIN users u ON u.id=p.user_id
     WHERE p.hackathon_id=$1 AND p.open_to_invites AND NOT EXISTS
       (SELECT 1 FROM team_members m WHERE m.hackathon_id=p.hackathon_id AND m.user_id=p.user_id)
     ORDER BY u.id LIMIT 10000`, [context.hackathonId])).rows;
  const items = candidates.map((r) => {
    const breakdown = scoreCandidate(teamSkills, needs, reference, r.skills, r.utc_offset_min);
    return { userId: r.id, displayName: r.display_name, skills: r.skills, utcOffsetMin: r.utc_offset_min, score: breakdown.total, breakdown };
  }).sort((a, b) => b.score - a.score || a.userId.localeCompare(b.userId)).slice(0, 20);
  return { scoring, items };
}
