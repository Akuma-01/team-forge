import pg from 'pg';

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required. Copy .env.example to .env and start PostgreSQL.');
  process.exitCode = 1;
} else {
  const client = new pg.Client({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 2_000,
    statement_timeout: 5_000,
  });
  try {
    await client.connect();
    const result = await client.query('SELECT 1 AS reachable, current_setting(\'server_version\') AS version');
    console.info(JSON.stringify(result.rows[0]));
  } catch {
    console.error('PostgreSQL connectivity check failed. Check the server and DATABASE_URL.');
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}
