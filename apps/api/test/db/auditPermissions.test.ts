import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testDatabase } from '../helpers/database.js';

describe('database least-privilege audit log permissions', () => {
  let db: Awaited<ReturnType<typeof testDatabase>>;
  let adminPool: pg.Pool;
  const runtimeRole = `test_runtime_${randomUUID().replaceAll('-', '')}`;
  const runtimePassword = 'test_runtime_secret';
  let runtimePool: pg.Pool;

  beforeAll(async () => {
    db = await testDatabase();
    adminPool = db.pool;

    // Create unprivileged runtime role in test database
    await adminPool.query(`CREATE ROLE "${runtimeRole}" WITH LOGIN PASSWORD '${runtimePassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE`);

    // Grant schema usage and table permissions within the test schema
    await adminPool.query(`GRANT USAGE ON SCHEMA "${db.schema}" TO "${runtimeRole}"`);
    await adminPool.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "${db.schema}" TO "${runtimeRole}"`);
    await adminPool.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA "${db.schema}" TO "${runtimeRole}"`);

    // Revoke mutation permissions on audit_log and grant only SELECT, INSERT
    await adminPool.query(`REVOKE ALL ON TABLE "${db.schema}".audit_log FROM "${runtimeRole}"`);
    await adminPool.query(`GRANT SELECT, INSERT ON TABLE "${db.schema}".audit_log TO "${runtimeRole}"`);

    // Create a connection pool authenticated as the unprivileged runtime role
    const parsed = new URL(db.connectionString);
    parsed.username = runtimeRole;
    parsed.password = runtimePassword;

    runtimePool = new pg.Pool({
      connectionString: parsed.toString(),
      max: 2,
      connectionTimeoutMillis: 2000,
      options: `-c search_path=${db.schema}`,
    });
  });

  afterAll(async () => {
    await runtimePool?.end();
    if (adminPool) {
      try {
        await adminPool.query(`DROP OWNED BY "${runtimeRole}" CASCADE`);
        await adminPool.query(`DROP ROLE IF EXISTS "${runtimeRole}"`);
      } catch {
        // ignore teardown role drops
      }
    }
    await db?.dispose();
  });

  it('permits runtime role to INSERT audit records', async () => {
    const insertRes = await runtimePool.query(
      `INSERT INTO audit_log (hackathon_id, actor_id, action)
       VALUES ('00000000-0000-4000-a000-000000000001', '00000000-0000-4000-a000-000000000001', 'test.inserted')
       RETURNING id, action`,
    );
    expect(insertRes.rowCount).toBe(1);
    expect(insertRes.rows[0]?.action).toBe('test.inserted');
  });

  it('permits runtime role to SELECT audit records', async () => {
    const selectRes = await runtimePool.query('SELECT action FROM audit_log WHERE action = $1', ['test.inserted']);
    expect(selectRes.rowCount).toBeGreaterThanOrEqual(1);
  });

  it('denies runtime role from executing UPDATE on audit_log (42501 permission denied)', async () => {
    await expect(
      runtimePool.query("UPDATE audit_log SET action = 'tampered' WHERE action = 'test.inserted'"),
    ).rejects.toThrow(expect.objectContaining({ code: '42501' }));
  });

  it('denies runtime role from executing DELETE on audit_log (42501 permission denied)', async () => {
    await expect(
      runtimePool.query("DELETE FROM audit_log WHERE action = 'test.inserted'"),
    ).rejects.toThrow(expect.objectContaining({ code: '42501' }));
  });

  it('denies runtime role from executing TRUNCATE on audit_log (42501 permission denied)', async () => {
    await expect(
      runtimePool.query('TRUNCATE TABLE audit_log'),
    ).rejects.toThrow(expect.objectContaining({ code: '42501' }));
  });

  it('denies runtime role from altering or disabling triggers on audit_log (42501 must be owner)', async () => {
    await expect(
      runtimePool.query('ALTER TABLE audit_log DISABLE TRIGGER audit_log_no_mutation'),
    ).rejects.toThrow(expect.objectContaining({ code: '42501' }));
  });
});
