import type { Pool } from 'pg';
import type { Hackathon, Registration } from '@teamforge/shared';
import { AppError } from '../../db/errors.js';
import type { Tx } from '../../db/tx.js';

type Row = {
  id: string; name: string; min_team_size: number; max_team_size: number;
  open_to_invites: boolean | null; registered_at: Date | null;
};
const query = `SELECT h.id, h.name, h.min_team_size, h.max_team_size, p.open_to_invites, p.registered_at
  FROM hackathons h LEFT JOIN hackathon_participants p ON p.hackathon_id = h.id AND p.user_id = $1`;
const dto = (row: Row): Hackathon => ({
  id: row.id, name: row.name, minTeamSize: row.min_team_size, maxTeamSize: row.max_team_size,
  registration: row.registered_at === null ? null : {
    hackathonId: row.id, openToInvites: row.open_to_invites!, registeredAt: row.registered_at.toISOString(),
  },
});

export async function listHackathons(pool: Pool, userId: string) {
  return { items: (await pool.query<Row>(`${query} ORDER BY h.created_at DESC, h.id`, [userId])).rows.map(dto) };
}

export async function getHackathon(pool: Pool, userId: string, hackathonId: string) {
  const { rows: [row] } = await pool.query<Row>(`${query} WHERE h.id = $2`, [userId, hackathonId]);
  if (!row) throw new AppError('NOT_FOUND', 404, 'Hackathon not found.');
  return dto(row);
}

export async function register(tx: Tx, userId: string, hackathonId: string): Promise<Registration> {
  if ((await tx.q('SELECT 1 FROM hackathons WHERE id = $1 FOR KEY SHARE', [hackathonId])).rowCount === 0) {
    throw new AppError('NOT_FOUND', 404, 'Hackathon not found.');
  }
  await tx.q('INSERT INTO hackathon_participants (hackathon_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [hackathonId, userId]);
  const { rows: [row] } = await tx.q<{ open_to_invites: boolean; registered_at: Date }>(
    'SELECT open_to_invites, registered_at FROM hackathon_participants WHERE hackathon_id = $1 AND user_id = $2', [hackathonId, userId]);
  return { hackathonId, openToInvites: row!.open_to_invites, registeredAt: row!.registered_at.toISOString() };
}

export async function updatePreference(tx: Tx, userId: string, hackathonId: string, openToInvites: boolean) {
  const { rows: [row] } = await tx.q<{ registered_at: Date }>(`UPDATE hackathon_participants SET open_to_invites = $3
    WHERE hackathon_id = $1 AND user_id = $2 RETURNING registered_at`, [hackathonId, userId, openToInvites]);
  if (!row) throw new AppError('NOT_REGISTERED', 403, 'Register for this hackathon first.');
  return { hackathonId, openToInvites, registeredAt: row.registered_at.toISOString() } satisfies Registration;
}
