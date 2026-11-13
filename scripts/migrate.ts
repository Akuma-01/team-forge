import { readConfig } from '../apps/api/src/config.js';
import { createPool } from '../apps/api/src/db/pool.js';
import { migrate } from '../apps/api/src/db/migrate.js';
import { logDatabaseError } from '../apps/api/src/db/errors.js';

const config = readConfig();
const pool = createPool({ ...config, DATABASE_URL: config.DATABASE_URL_DIRECT ?? config.DATABASE_URL });
try {
  const applied = await migrate(pool);
  console.info(JSON.stringify({ event: 'migrations.complete', applied }));
} catch (error) {
  logDatabaseError('migrations.failed', error);
  process.exitCode = 1;
} finally { await pool.end(); }
