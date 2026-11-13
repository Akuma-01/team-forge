import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { testDatabase } from '../helpers/database.js';
import { migrate } from '../../src/db/migrate.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function bare() {
  const db = await testDatabase(false);
  cleanup.push(db.dispose);
  return db;
}

async function migrationFiles() {
  const dir = await mkdtemp(join(tmpdir(), 'teamforge-migrations-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

describe('transactional migration runner', () => {
  it('migrates an empty schema exactly once even with concurrent runners', async () => {
    const { pool } = await bare();
    const results = await Promise.all([migrate(pool), migrate(pool)]);
    expect(results.map((r) => r.length).sort()).toEqual([0, 2]);
    expect(await migrate(pool)).toEqual([]);
    expect((await pool.query('SELECT name FROM schema_migrations ORDER BY name')).rows.map((r) => r.name))
      .toEqual(['0001_schema.sql', '0002_triggers.sql']);
    const constraints = await pool.query("SELECT condeferrable, condeferred FROM pg_constraint WHERE conrelid = 'teams'::regclass AND conname = 'teams_leader_is_member_fk'");
    expect(constraints.rows).toEqual([{ condeferrable: true, condeferred: true }]);
  });

  it('rolls back the entire migration batch and releases the migration lock on SQL failure', async () => {
    const { pool } = await bare();
    const dir = await migrationFiles();
    await writeFile(join(dir, '0001_first.sql'), 'CREATE TABLE migration_probe (id integer);');
    await writeFile(join(dir, '0002_bad.sql'), 'SELECT 1 / 0;');
    await expect(migrate(pool, dir)).rejects.toMatchObject({ code: '22012' });
    expect((await pool.query("SELECT to_regclass('migration_probe') AS probe, to_regclass('schema_migrations') AS history")).rows[0])
      .toEqual({ probe: null, history: null });
    await writeFile(join(dir, '0002_bad.sql'), 'INSERT INTO migration_probe VALUES (1);');
    expect(await migrate(pool, dir)).toHaveLength(2);
  });

  it('rejects modified or deleted applied migration history', async () => {
    const { pool } = await bare();
    const dir = await migrationFiles();
    const path = join(dir, '0001_first.sql');
    await writeFile(path, 'CREATE TABLE migration_probe (id integer);');
    await migrate(pool, dir);
    await writeFile(path, `${await readFile(path, 'utf8')}\n-- modified`);
    await expect(migrate(pool, dir)).rejects.toThrow('Migration history differs');
    await rm(path);
    await writeFile(join(dir, '0002_second.sql'), 'SELECT 1;');
    await expect(migrate(pool, dir)).rejects.toThrow('Migration history differs');
  });
});
