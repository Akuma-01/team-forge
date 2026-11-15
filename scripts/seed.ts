import { writeFile, mkdir, open } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import type { Pool } from 'pg';
import { readConfig } from '../apps/api/src/config.js';
import { createPool } from '../apps/api/src/db/pool.js';
import { createPasswords } from '../apps/api/src/modules/auth/password.js';
import { SignJWT } from 'jose';
import { issuer, audience } from '../apps/api/src/modules/auth/session.js';
import { assertInvariants } from '../apps/api/src/db/invariants.js';

export const SEED_HACKATHON_ID = '00000000-0000-4000-a000-000000000001';
export const SEED_HACKATHON_NAME = 'Hack4Hack Crew Hiring Challenge 2026';

export async function seed(poolOrConfig?: Pool, outputDirectory = resolve('loadtest')) {
  if (process.env.SEED_DEMO !== 'true') throw new Error('Seeding requires SEED_DEMO=true and an explicitly selected demo/test database.');
  const startTime = performance.now();
  const config = readConfig();
  const pool = poolOrConfig?.query ? poolOrConfig : createPool({
    ...config,
    DATABASE_URL: config.DATABASE_URL_DIRECT ?? config.DATABASE_URL,
  });

  const ownsPool = !poolOrConfig?.query;

  try {
    console.info(`Starting deterministic seed for ${SEED_HACKATHON_NAME}...`);

    // 1. Precompute Argon2 hash once for all demo users
    const passwords = createPasswords();
    const seedPassword = process.env.SEED_PASSWORD || 'demo-only-replace-before-seeding';
    const passwordHash = await passwords.hash(seedPassword);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Set timeout limits for safety
      await client.query("SET LOCAL statement_timeout = '120s'");

      // Serialize repeat invocations without deleting participants, requests or history.
      await client.query('SELECT pg_advisory_xact_lock(7348261)');
      const existing = await client.query<{ name: string }>('SELECT name FROM hackathons WHERE id=$1', [SEED_HACKATHON_ID]);
      if (existing.rows.length && existing.rows[0]!.name !== SEED_HACKATHON_NAME) {
        throw new Error('The seed hackathon ID is already in use; refusing to change existing data.');
      }
      if (!existing.rows.length) {
      // 2. Ensure the demo hackathon exists
      console.info('Upserting hackathon...');
      await client.query(`
        INSERT INTO hackathons (id, name, min_team_size, max_team_size)
        VALUES ($1, $2, 2, 4)
;
      `, [SEED_HACKATHON_ID, SEED_HACKATHON_NAME]);

      // 3. Insert exactly 10,000 deterministic users
      console.info('Seeding 10,000 users...');
      await client.query(`
        WITH catalogue AS (
          SELECT ARRAY['frontend', 'backend', 'design', 'ml', 'data', 'mobile', 'devops', 'security', 'product', 'blockchain']::text[] AS s
        ),
        offsets AS (
          SELECT ARRAY[330, 330, 330, 330, 330, 330, 330, 330, 360, 300, 345, 0, 60, -300, -480, 480]::smallint[] AS o
        )
        INSERT INTO users (id, email, password_hash, display_name, skills, utc_offset_min, is_organizer, created_at)
        SELECT
          CAST(lpad(to_hex(i), 8, '0') || '-0000-4000-a000-' || lpad(to_hex(i), 12, '0') AS uuid) AS id,
          'seed_user_' || lpad(i::text, 5, '0') || '@teamforge.demo' AS email,
          $1 AS password_hash,
          'Seed User ' || lpad(i::text, 5, '0') AS display_name,
          (c.s || c.s)[(1 + ((i * 3) % 10)) : (1 + ((i * 3) % 10)) + ((i * 7 + 1) % 4)] AS skills,
          o.o[1 + ((i * 11) % 16)] AS utc_offset_min,
          false AS is_organizer,
          now() - interval '7 days' + (i * interval '30 seconds') AS created_at
        FROM catalogue c, offsets o, generate_series(1, 10000) AS i;
      `, [passwordHash]);

      // 4. Register all 10,000 users in the hackathon
      console.info('Registering 10,000 participants...');
      await client.query(`
        INSERT INTO hackathon_participants (hackathon_id, user_id, open_to_invites, registered_at)
        SELECT
          $1 AS hackathon_id,
          CAST(lpad(to_hex(i), 8, '0') || '-0000-4000-a000-' || lpad(to_hex(i), 12, '0') AS uuid) AS user_id,
          true AS open_to_invites,
          now() - interval '6 days' + (i * interval '30 seconds') AS registered_at
        FROM generate_series(1, 10000) AS i;
      `, [SEED_HACKATHON_ID]);

      // 5. Insert exactly 2,000 teams
      // Team distribution:
      // - 400 teams of size 1 (j = 1..400)
      // - 600 teams of size 2 (j = 401..1000)
      // - 700 teams of size 3 (j = 1001..1700)
      // - 300 teams of size 4 (j = 1701..2000)
      console.info('Seeding 2,000 teams...');
      await client.query(`
        WITH catalogue AS (
          SELECT ARRAY['frontend', 'backend', 'design', 'ml', 'data', 'mobile', 'devops', 'security', 'product', 'blockchain']::text[] AS s
        ),
        team_defs AS (
          SELECT j,
            CASE
              WHEN j <= 400 THEN 1
              WHEN j <= 1000 THEN 2
              WHEN j <= 1700 THEN 3
              ELSE 4
            END AS target_size,
            CASE
              WHEN j <= 400 THEN j
              WHEN j <= 1000 THEN 2 * j - 401
              WHEN j <= 1700 THEN 3 * j - 1399
              ELSE 4 * j - 3099
            END AS leader_user_idx
          FROM generate_series(1, 2000) AS j
        )
        INSERT INTO teams (
          id, hackathon_id, name, description, looking_for, is_open,
          leader_id, min_size, max_size, member_count, invite_code,
          invite_expires_at, version, created_at, updated_at
        )
        SELECT
          CAST(lpad(to_hex(td.j), 8, '0') || '-0000-4000-b000-' || lpad(to_hex(td.j), 12, '0') AS uuid) AS id,
          $1 AS hackathon_id,
          'Team ' || lpad(td.j::text, 4, '0') AS name,
          'Deterministic seed team ' || td.j || ' collaborating on high-performance solutions' AS description,
          (c.s || c.s)[(1 + ((td.j * 3) % 10)) : (1 + ((td.j * 3) % 10)) + ((td.j * 5) % 3)] AS looking_for,
          (td.target_size < 4) AS is_open,
          CAST(lpad(to_hex(td.leader_user_idx), 8, '0') || '-0000-4000-a000-' || lpad(to_hex(td.leader_user_idx), 12, '0') AS uuid) AS leader_id,
          2 AS min_size,
          4 AS max_size,
          0 AS member_count,
          upper(substr(md5('seed_team_invite_' || td.j), 1, 10)) AS invite_code,
          now() + interval '48 hours' AS invite_expires_at,
          1 AS version,
          now() - interval '5 days' + (td.j * interval '60 seconds') AS created_at,
          now() - interval '5 days' + (td.j * interval '60 seconds') AS updated_at
        FROM catalogue c, team_defs td;
      `, [SEED_HACKATHON_ID]);

      // 6. Insert exactly 4,900 memberships across the 2,000 teams
      console.info('Seeding 4,900 team memberships...');
      await client.query(`
        WITH team_defs AS (
          SELECT j,
            CASE
              WHEN j <= 400 THEN 1
              WHEN j <= 1000 THEN 2
              WHEN j <= 1700 THEN 3
              ELSE 4
            END AS target_size,
            CASE
              WHEN j <= 400 THEN j
              WHEN j <= 1000 THEN 2 * j - 401
              WHEN j <= 1700 THEN 3 * j - 1399
              ELSE 4 * j - 3099
            END AS start_user
          FROM generate_series(1, 2000) AS j
        ),
        memberships AS (
          SELECT
            td.j AS team_idx,
            td.start_user + offset_idx AS user_idx,
            offset_idx = 0 AS is_leader
          FROM team_defs td
          CROSS JOIN LATERAL generate_series(0, td.target_size - 1) AS offset_idx
        )
        INSERT INTO team_members (team_id, hackathon_id, user_id, joined_at)
        SELECT
          CAST(lpad(to_hex(m.team_idx), 8, '0') || '-0000-4000-b000-' || lpad(to_hex(m.team_idx), 12, '0') AS uuid) AS team_id,
          $1 AS hackathon_id,
          CAST(lpad(to_hex(m.user_idx), 8, '0') || '-0000-4000-a000-' || lpad(to_hex(m.user_idx), 12, '0') AS uuid) AS user_id,
          now() - interval '4 days' + (m.user_idx * interval '30 seconds') AS joined_at
        FROM memberships m;
      `, [SEED_HACKATHON_ID]);

      // 7. Insert audit trail records for each membership
      console.info('Seeding audit logs for memberships...');
      await client.query(`
        WITH team_defs AS (
          SELECT j,
            CASE
              WHEN j <= 400 THEN 1
              WHEN j <= 1000 THEN 2
              WHEN j <= 1700 THEN 3
              ELSE 4
            END AS target_size,
            CASE
              WHEN j <= 400 THEN j
              WHEN j <= 1000 THEN 2 * j - 401
              WHEN j <= 1700 THEN 3 * j - 1399
              ELSE 4 * j - 3099
            END AS start_user
          FROM generate_series(1, 2000) AS j
        ),
        memberships AS (
          SELECT
            td.j AS team_idx,
            td.start_user + offset_idx AS user_idx,
            offset_idx = 0 AS is_leader
          FROM team_defs td
          CROSS JOIN LATERAL generate_series(0, td.target_size - 1) AS offset_idx
        )
        INSERT INTO audit_log (hackathon_id, team_id, actor_id, target_user_id, action, details, request_id, created_at)
        SELECT
          $1 AS hackathon_id,
          CAST(lpad(to_hex(m.team_idx), 8, '0') || '-0000-4000-b000-' || lpad(to_hex(m.team_idx), 12, '0') AS uuid) AS team_id,
          CAST(lpad(to_hex(m.user_idx), 8, '0') || '-0000-4000-a000-' || lpad(to_hex(m.user_idx), 12, '0') AS uuid) AS actor_id,
          CAST(lpad(to_hex(m.user_idx), 8, '0') || '-0000-4000-a000-' || lpad(to_hex(m.user_idx), 12, '0') AS uuid) AS target_user_id,
          CASE WHEN m.is_leader THEN 'team.created' ELSE 'member.joined' END AS action,
          CASE
            WHEN m.is_leader THEN jsonb_build_object('name', 'Team ' || lpad(m.team_idx::text, 4, '0'), 'via', 'seed')
            ELSE jsonb_build_object('via', 'seed')
          END AS details,
          'seed-request-' || m.user_idx AS request_id,
          now() - interval '4 days' + (m.user_idx * interval '30 seconds') AS created_at
        FROM memberships m;
      `, [SEED_HACKATHON_ID]);

      } else {
        console.info('Existing demo dataset found; preserving all rows and verifying baseline counts.');
      }
      const counts = (await client.query(`SELECT
        (SELECT count(*)::int FROM hackathon_participants WHERE hackathon_id=$1) AS participants,
        (SELECT count(*)::int FROM teams WHERE hackathon_id=$1) AS teams,
        (SELECT count(*)::int FROM team_members WHERE hackathon_id=$1) AS memberships,
        (SELECT count(*)::int FROM generate_series(1,10000) AS i
          JOIN users u ON u.id=(lpad(to_hex(i),8,'0') || '-0000-4000-a000-' || lpad(to_hex(i),12,'0'))::uuid
            AND u.email='seed_user_' || lpad(i::text,5,'0') || '@teamforge.demo'
          JOIN hackathon_participants p ON p.user_id=u.id AND p.hackathon_id=$1) AS demo_participants`, [SEED_HACKATHON_ID])).rows[0];
      const sizes = (await client.query('SELECT member_count, count(*)::int AS count FROM teams WHERE hackathon_id=$1 GROUP BY member_count ORDER BY member_count', [SEED_HACKATHON_ID])).rows;
      if (counts.participants !== 10000 || counts.demo_participants !== 10000 || counts.teams !== 2000 || counts.memberships !== 4900
        || JSON.stringify(sizes) !== JSON.stringify([{ member_count: 1, count: 400 }, { member_count: 2, count: 600 }, { member_count: 3, count: 700 }, { member_count: 4, count: 300 }])) {
        throw new Error('Demo dataset differs from the baseline; use a fresh demo/test database. Existing data was not reset.');
      }
      await client.query('COMMIT');
      console.info('Database transaction committed successfully.');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }

    // 8. Generate short-lived auth tokens for 200 seeded users in loadtest/tokens.json
    console.info('Generating tokens for 200 users...');
    const issuedAt = Math.floor(Date.now() / 1000);
    const expiresAt = issuedAt + 2 * 60 * 60;
    const key = new TextEncoder().encode(config.JWT_SECRET);
    const tokens: string[] = [];
    for (let i = 1; i <= 200; i++) {
      const hex = i.toString(16).padStart(8, '0');
      const hexEnd = i.toString(16).padStart(12, '0');
      const userId = `${hex}-0000-4000-a000-${hexEnd}`;
      const token = await new SignJWT({}).setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
        .setSubject(userId).setIssuer(issuer).setAudience(audience)
        .setIssuedAt(issuedAt).setExpirationTime(expiresAt).sign(key);
      tokens.push(token);
    }

    const tokensPath = resolve(outputDirectory, 'tokens.json');
    await mkdir(dirname(tokensPath), { recursive: true });
    const tokenFile = await open(tokensPath, 'w', 0o600);
    try { await tokenFile.chmod(0o600); await tokenFile.writeFile(JSON.stringify(tokens, null, 2), 'utf-8'); }
    finally { await tokenFile.close(); }
    console.info(`Saved ${tokens.length} short-lived tokens to ${tokensPath}`);

    // Also write target info for load test scripts
    const targetPath = resolve(outputDirectory, 'target.json');
    await writeFile(targetPath, JSON.stringify({
      hackathonId: SEED_HACKATHON_ID,
      hackathonName: SEED_HACKATHON_NAME,
      tokenExpiresAt: new Date(expiresAt * 1000).toISOString(),
      seededUsers: 10000,
      seededTeams: 2000,
      seededMemberships: 4900,
      openTeams: 1700,
      fullTeams: 300,
    }, null, 2), 'utf-8');

    // 9. Run invariant checks on the seeded dataset
    console.info('Verifying invariants on seeded dataset...');
    await assertInvariants(pool, SEED_HACKATHON_ID);
    console.info('All database invariants passed with 0 violations!');

    const elapsedMs = Math.round(performance.now() - startTime);
    console.info(JSON.stringify({
      event: 'seed.complete',
      hackathonId: SEED_HACKATHON_ID,
      users: 10000,
      teams: 2000,
      memberships: 4900,
      tokens: tokens.length,
      durationMs: elapsedMs,
    }));
  } finally {
    if (ownsPool) {
      await pool.end();
    }
  }
}

// Direct execution
if (process.argv[1]?.endsWith('seed.ts') || process.argv[1]?.endsWith('seed.js')) {
  try {
    await seed();
  } catch (error) {
    console.error('Seed failed:', error);
    process.exit(1);
  }
}
