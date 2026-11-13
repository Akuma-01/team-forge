import { access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { readConfig } from './config.js';
import { createPool } from './db/pool.js';
import { migrate } from './db/migrate.js';
import { logDatabaseError } from './db/errors.js';

async function main() {
  const config = readConfig();
  const production = config.NODE_ENV === 'production';
  const webDirectory = fileURLToPath(new URL('../../web/dist/', import.meta.url));
  if (production) await access(`${webDirectory}index.html`);

  const migrationPool = createPool({ ...config, DATABASE_URL: config.DATABASE_URL_DIRECT ?? config.DATABASE_URL });
  try {
    const applied = await migrate(migrationPool);
    console.info(JSON.stringify({ event: 'migrations.complete', applied }));
  } catch (error) {
    logDatabaseError('migrations.failed', error);
    throw new Error('Database migration failed; startup stopped.');
  } finally { await migrationPool.end(); }

  const pool = createPool(config);
  const app = createApp({
    production,
    ...(production ? { webDirectory } : {}),
    checkDatabase: async () => { await pool.query('SELECT 1'); },
  });
  const server = app.listen(config.PORT, config.HOST, () => {
    console.info(JSON.stringify({ event: 'server.started', host: config.HOST, port: config.PORT }));
  });
  server.on('error', (error: NodeJS.ErrnoException) => {
    console.error(JSON.stringify({ event: 'server.failed', code: error.code }));
    void pool.end().finally(() => { process.exitCode = 1; });
  });

  let closing = false;
  function shutdown() {
    if (closing) return;
    closing = true;
    const deadline = setTimeout(() => process.exit(1), 10_000);
    deadline.unref();
    server.close(() => {
      void pool.end().then(() => {
        clearTimeout(deadline);
        console.info(JSON.stringify({ event: 'server.stopped' }));
      }).catch(() => { process.exitCode = 1; });
    });
  }
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Startup failed.');
  process.exitCode = 1;
});
