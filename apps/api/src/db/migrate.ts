import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import { guardClient } from './client.js';

const defaultDirectory = fileURLToPath(new URL('./migrations/', import.meta.url));
const migrationLock = 2026111301;

export async function migrate(pool: Pool, directory = defaultDirectory): Promise<string[]> {
  const names = (await readdir(directory)).filter((name) => name.endsWith('.sql')).sort();
  if (names.length === 0 || names.some((name) => !/^\d{4}_[a-z0-9_]+\.sql$/.test(name))) {
    throw new Error('Migration files must use ordered NNNN_name.sql filenames.');
  }
  if (new Set(names.map((name) => name.slice(0, 4))).size !== names.length) {
    throw new Error('Migration sequence numbers must be unique.');
  }
  const files = await Promise.all(names.map(async (name) => {
    const sql = await readFile(join(directory, name), 'utf8');
    return { name, sql, checksum: createHash('sha256').update(sql).digest('hex') };
  }));
  const client = await pool.connect();
  const guard = guardClient(client);
  let discard = false;
  try {
    await client.query(`BEGIN;
      SELECT set_config('lock_timeout', '10s', true),
             set_config('statement_timeout', '30s', true),
             set_config('idle_in_transaction_session_timeout', '30s', true)`);
    await client.query('SELECT pg_advisory_xact_lock($1)', [migrationLock]);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
    )`);
    const { rows } = await client.query<{ name: string; checksum: string }>(
      'SELECT name, checksum FROM schema_migrations ORDER BY name',
    );
    // Applied migrations must be an unchanged prefix, preventing deleted/reordered history.
    for (const [index, applied] of rows.entries()) {
      const file = files[index];
      if (!file || applied.name !== file.name || applied.checksum !== file.checksum) {
        throw new Error('Migration history differs from the checked-in SQL files.');
      }
    }
    const applied: string[] = [];
    for (const file of files.slice(rows.length)) {
      await client.query(file.sql);
      await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [file.name, file.checksum]);
      applied.push(file.name);
    }
    await client.query('COMMIT');
    return applied;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { discard = true; }
    throw error;
  } finally { guard.release(discard); }
}
