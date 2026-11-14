import type { Pool } from 'pg';
import type { SignupInput, Profile, ProfilePatch, Registration, Skill } from '@teamforge/shared';
import { AppError } from '../../db/errors.js';
import { withTx } from '../../db/tx.js';

type UserRow = { id: string; email: string; display_name: string; skills: Skill[]; utc_offset_min: number };

export async function signup(pool: Pool, input: SignupInput, passwordHash: string) {
  return withTx(pool, async (tx) => {
    const result = await tx.q<{ id: string }>(`INSERT INTO users (email, password_hash, display_name)
      VALUES ($1, $2, $3) ON CONFLICT (lower(email)) DO NOTHING RETURNING id`,
    [input.email, passwordHash, input.displayName]);
    if (!result.rows[0]) throw new AppError('VALIDATION_ERROR', 409, 'Unable to create an account with these details. Try signing in.');
    return result.rows[0].id;
  });
}

export async function profile(pool: Pool, userId: string): Promise<Profile> {
  const { rows: [user] } = await pool.query<UserRow>(
    'SELECT id, email, display_name, skills, utc_offset_min FROM users WHERE id = $1', [userId]);
  if (!user) throw new AppError('UNAUTHENTICATED', 401, 'Please sign in to continue.');
  const { rows } = await pool.query<{ hackathon_id: string; open_to_invites: boolean; registered_at: Date }>(
    'SELECT hackathon_id, open_to_invites, registered_at FROM hackathon_participants WHERE user_id = $1 ORDER BY registered_at, hackathon_id', [userId]);
  const registrations: Registration[] = rows.map((row) => ({ hackathonId: row.hackathon_id, openToInvites: row.open_to_invites, registeredAt: row.registered_at.toISOString() }));
  return { id: user.id, email: user.email, displayName: user.display_name, skills: user.skills, utcOffsetMin: user.utc_offset_min, registrations };
}

export async function updateProfile(pool: Pool, userId: string, input: ProfilePatch) {
  await withTx(pool, async (tx) => {
    const result = await tx.q(`UPDATE users SET display_name = COALESCE($2, display_name),
      skills = COALESCE($3::text[], skills), utc_offset_min = COALESCE($4, utc_offset_min)
      WHERE id = $1 RETURNING id`, [userId, input.displayName ?? null, input.skills ?? null, input.utcOffsetMin ?? null]);
    if (result.rowCount !== 1) throw new AppError('UNAUTHENTICATED', 401, 'Please sign in to continue.');
  });
  return profile(pool, userId);
}
