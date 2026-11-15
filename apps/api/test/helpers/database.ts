import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { migrate } from '../../src/db/migrate.js';

export function requireTestDatabase(env: NodeJS.ProcessEnv = process.env): string {
  const value = env.TEST_DATABASE_URL;
  const url = value ? URL.parse(value) : null;
  const hostParam = url?.searchParams.get('host');
  const isLocalUnixSocket = url?.searchParams.size === 1 && hostParam !== null && hostParam.startsWith('/');
  if (!value || !url || !['postgres:', 'postgresql:'].includes(url.protocol)
      || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      || !/^\/[a-z0-9_]+_test$/.test(url.pathname)
      || (url.search !== '' && !isLocalUnixSocket) || env.NODE_ENV === 'production') {
    throw new Error('Tests require TEST_DATABASE_URL pointing to a local, dedicated database ending in _test.');
  }
  return value;
}

export async function testDatabase(applyMigrations = true) {
  const connectionString = requireTestDatabase();
  const schema = `spec_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString, max: 1, connectionTimeoutMillis: 2_000 });
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`); // Identifier generated internally, never user input.
  } catch (error) { await admin.end(); throw error; }
  const pool = new pg.Pool({
    connectionString, max: 20, connectionTimeoutMillis: 2_000,
    statement_timeout: 5_000, idleTimeoutMillis: 1_000,
    options: `-c search_path=${schema}`,
  });
  const dispose = async () => {
    await pool.end();
    try { await admin.query(`DROP SCHEMA "${schema}" CASCADE`); }
    finally { await admin.end(); }
  };
  try { if (applyMigrations) await migrate(pool); }
  catch (error) { await dispose(); throw error; }
  return { pool, schema, dispose, connectionString };
}
