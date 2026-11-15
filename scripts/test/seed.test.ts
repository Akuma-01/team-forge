import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { decodeJwt } from 'jose';
import { testDatabase } from '../../apps/api/test/helpers/database.js';
import { createParticipants } from '../../apps/api/test/helpers/factories.js';
import { seed, SEED_HACKATHON_ID } from '../seed.js';

let db: Awaited<ReturnType<typeof testDatabase>>;
let directory: string;
beforeEach(async () => {
  db = await testDatabase(); directory = await mkdtemp(resolve(tmpdir(), 'teamforge-seed-review-'));
  vi.stubEnv('SEED_DEMO', 'true');
});
afterEach(async () => {
  vi.unstubAllEnvs(); await db?.dispose();
  if (directory) await rm(directory, { recursive: true, force: true });
});

it('refuses an unacknowledged database without changing it', async () => {
  vi.stubEnv('SEED_DEMO', undefined);
  const { users } = await createParticipants(db.pool, 1);
  await expect(seed(db.pool, directory)).rejects.toThrow('SEED_DEMO=true');
  expect((await db.pool.query('SELECT id FROM users')).rows).toEqual([{ id: users[0] }]);
});

it('seeds the required distribution, reuses it without duplicate audit, and preserves real activity on refusal', async () => {
  await seed(db.pool, directory);
  await seed(db.pool, directory);
  expect((await db.pool.query('SELECT count(*)::int AS count FROM audit_log')).rows[0].count).toBe(4900);
  const tokenFile = resolve(directory, 'tokens.json');
  const tokens = JSON.parse(await readFile(tokenFile, 'utf8')) as string[];
  expect(tokens).toHaveLength(200);
  const claims = decodeJwt(tokens[0]!);
  expect(claims.exp! - claims.iat!).toBe(7200);
  expect((await stat(tokenFile)).mode & 0o777).toBe(0o600);

  const { users } = await createParticipants(db.pool, 1);
  await db.pool.query('INSERT INTO hackathon_participants(hackathon_id,user_id) VALUES($1,$2)', [SEED_HACKATHON_ID, users[0]]);
  const { rows: [request] } = await db.pool.query(`INSERT INTO join_requests(hackathon_id,team_id,user_id,message)
    VALUES($1,'00000001-0000-4000-b000-000000000001',$2,'Keep my application') RETURNING id`, [SEED_HACKATHON_ID, users[0]]);
  await expect(seed(db.pool, directory)).rejects.toThrow('differs from the baseline');
  expect((await db.pool.query('SELECT message FROM join_requests WHERE id=$1', [request.id])).rows[0].message).toBe('Keep my application');
  expect((await db.pool.query('SELECT count(*)::int AS count FROM users')).rows[0].count).toBe(10001);
  expect((await db.pool.query('SELECT count(*)::int AS count FROM team_members')).rows[0].count).toBe(4900);
}, 60_000);

it('propagates a k6 threshold failure through the real runner and stops its server', async () => {
  await seed(db.pool, directory);
  // This executable simulates a failed k6 process, not application throughput.
  const fakeK6 = resolve(directory, 'failed-k6');
  await writeFile(fakeK6, `#!/usr/bin/env node
const fs = require('node:fs');
if (process.argv[2] === 'version') { console.log('failure-test-fixture'); process.exit(0); }
const summary = process.argv.find(x => x.startsWith('--summary-export=')).split('=')[1];
fs.writeFileSync(summary, JSON.stringify({ metrics: { 'successful_board_duration{phase:measurement}': { min: 1 } } }));
process.exit(99);
`, { mode: 0o700 });
  const connection = new URL(db.connectionString);
  connection.searchParams.set('options', `-c search_path=${db.schema}`);
  const results = resolve(directory, 'results');
  const run = promisify(execFile)(process.execPath, ['--import', 'tsx', 'scripts/run-loadtest.ts', 'realistic'], {
    cwd: resolve(import.meta.dirname, '../..'), timeout: 30_000,
    env: { ...process.env, DATABASE_URL: connection.href, DATABASE_URL_DIRECT: connection.href,
      TOKENS_FILE: resolve(directory, 'tokens.json'), LOADTEST_OUTPUT_DIR: results, K6_BIN: fakeK6 },
  });
  await expect(run).rejects.toMatchObject({ code: 1 });
  const metadata = JSON.parse(await readFile(resolve(results, 'metadata.json'), 'utf8'));
  expect(metadata.runs[0].code).toBe(99);
  expect(metadata.performanceGatePassed).toBe(false);
  await expect(fetch(`http://127.0.0.1:${metadata.localPort}/ready`, { signal: AbortSignal.timeout(1000) })).rejects.toThrow();
}, 60_000);
