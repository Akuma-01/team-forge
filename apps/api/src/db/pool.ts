import pg from 'pg';
import type { Config } from '../config.js';
import { logDatabaseError } from './errors.js';

export function createPool(config: Config): pg.Pool {
  const pool = new pg.Pool({
    connectionString: config.DATABASE_URL,
    max: config.PG_POOL_MAX,
    connectionTimeoutMillis: Number(process.env.PG_CONNECTION_TIMEOUT_MS ?? 10_000),
    idleTimeoutMillis: 30_000,
    statement_timeout: 5_000,
    application_name: 'teamforge',
  });
  pool.on('error', (error) => logDatabaseError('database.idle_connection.failed', error));
  return pool;
}
