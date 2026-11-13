import { randomBytes, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { Tx } from '../../src/db/tx.js';
import { withTx } from '../../src/db/tx.js';

export async function createParticipants(pool: Pool, count = 3, hackathonId = randomUUID()) {
  const users = Array.from({ length: count }, () => randomUUID());
  await withTx(pool, async (tx) => {
    await tx.q(`INSERT INTO hackathons (id, name, min_team_size, max_team_size)
      VALUES ($1, 'Test hackathon', 2, 4) ON CONFLICT (id) DO NOTHING`, [hackathonId]);
    for (const id of users) {
      await tx.q(`INSERT INTO users (id, email, password_hash, display_name)
        VALUES ($1, $2, 'not-a-login-credential', 'Test participant')`, [id, `${id}@test.invalid`]);
      await tx.q('INSERT INTO hackathon_participants (hackathon_id, user_id) VALUES ($1, $2)', [hackathonId, id]);
    }
  });
  return { hackathonId, users };
}

export async function membership(tx: Tx, hackathonId: string, teamId: string, userId: string, audit = true) {
  await tx.q('INSERT INTO team_members (team_id, hackathon_id, user_id) VALUES ($1, $2, $3)', [teamId, hackathonId, userId]);
  if (audit) {
    await tx.q(`INSERT INTO audit_log (hackathon_id, team_id, actor_id, target_user_id, action)
      VALUES ($1, $2, $3, $3, 'member.joined')`, [hackathonId, teamId, userId]);
  }
}

export async function createTeam(pool: Pool, hackathonId: string, leaderId: string, maxSize = 4, audit = true) {
  const teamId = randomUUID();
  const code = [...randomBytes(10)].map((n) => '0123456789ABCDEFGHJKMNPQRSTVWXYZ'[n & 31]).join('');
  await withTx(pool, async (tx) => {
    await tx.q('SELECT 1 FROM hackathon_participants WHERE hackathon_id = $1 AND user_id = $2 FOR NO KEY UPDATE', [hackathonId, leaderId]);
    await tx.q(`INSERT INTO teams (id, hackathon_id, name, leader_id, min_size, max_size, invite_code, invite_expires_at)
      VALUES ($1, $2, $3, $4, 2, $5, $6, clock_timestamp() + interval '1 hour')`,
    [teamId, hackathonId, `Team ${teamId}`, leaderId, maxSize, code]);
    await membership(tx, hackathonId, teamId, leaderId, audit);
  });
  return teamId;
}
