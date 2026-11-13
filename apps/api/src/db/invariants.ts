import type { Pool } from 'pg';
import { guardClient } from './client.js';

// Each check is scoped independently, including requests and orphaned team histories.
const checks = [
  ['B.1', `SELECT t.id AS team_id FROM teams t
    WHERE ($1::uuid IS NULL OR t.hackathon_id = $1)
      AND t.member_count <> (SELECT count(*) FROM team_members m WHERE m.team_id = t.id)`],
  ['B.2', `SELECT t.id AS team_id FROM teams t
    WHERE ($1::uuid IS NULL OR t.hackathon_id = $1)
      AND t.max_size < (SELECT count(*) FROM team_members m WHERE m.team_id = t.id)`],
  ['B.3', `SELECT t.id AS team_id FROM teams t
    WHERE ($1::uuid IS NULL OR t.hackathon_id = $1)
      AND NOT EXISTS (SELECT 1 FROM team_members m WHERE m.team_id = t.id)`],
  ['B.4', `SELECT t.id AS team_id FROM teams t
    WHERE ($1::uuid IS NULL OR t.hackathon_id = $1)
      AND NOT EXISTS (SELECT 1 FROM team_members m WHERE m.team_id = t.id AND m.user_id = t.leader_id)`],
  ['B.5', `SELECT hackathon_id, user_id FROM team_members
    WHERE ($1::uuid IS NULL OR hackathon_id = $1)
    GROUP BY hackathon_id, user_id HAVING count(*) > 1`],
  ['B.6', `SELECT m.team_id, m.user_id FROM team_members m JOIN teams t ON t.id = m.team_id
    WHERE ($1::uuid IS NULL OR m.hackathon_id = $1 OR t.hackathon_id = $1)
      AND t.hackathon_id <> m.hackathon_id`],
  ['B.7', `SELECT r.id AS request_id FROM join_requests r
    JOIN team_members m ON m.hackathon_id = r.hackathon_id AND m.user_id = r.user_id
    WHERE ($1::uuid IS NULL OR r.hackathon_id = $1) AND r.status = 'pending'`],
  ['B.8', `SELECT m.team_id, m.user_id FROM team_members m
    WHERE ($1::uuid IS NULL OR m.hackathon_id = $1)
      AND NOT EXISTS (SELECT 1 FROM audit_log a WHERE a.team_id = m.team_id
        AND a.hackathon_id = m.hackathon_id AND a.target_user_id = m.user_id
        AND a.action IN ('team.created', 'member.joined'))`],
] as const;

export async function checkInvariants(pool: Pool, hackathonId?: string) {
  const client = await pool.connect();
  const guard = guardClient(client);
  let discard = false;
  try {
    // Diagnostic reads need one consistent snapshot while the app may still be mutating.
    // Business transactions remain READ COMMITTED.
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const results = [];
    for (const [id, sql] of checks) {
      const { rows } = await client.query(sql, [hackathonId ?? null]);
      results.push({ id, violations: rows });
    }
    await client.query('COMMIT');
    return results;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { discard = true; }
    throw error;
  } finally { guard.release(discard); }
}

export async function assertInvariants(pool: Pool, hackathonId: string) {
  const failures = (await checkInvariants(pool, hackathonId)).filter((check) => check.violations.length > 0);
  if (failures.length) throw new Error(`Invariant violations: ${JSON.stringify(failures)}`);
}
