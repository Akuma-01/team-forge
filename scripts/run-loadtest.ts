import { startServer, stopServer, k6Command, requireK6Success } from './benchmark-process.js';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cpus, release } from 'node:os';
import { existsSync } from 'node:fs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { checkInvariants } from '../apps/api/src/db/invariants.js';
import { createPool } from '../apps/api/src/db/pool.js';
import { readConfig } from '../apps/api/src/config.js';
import { SEED_HACKATHON_ID } from './seed.js';

const ROOT_DIR = resolve(import.meta.dirname, '..');
const TOKENS_PATH = resolve(process.env.TOKENS_FILE ?? resolve(ROOT_DIR, 'loadtest/tokens.json'));
const BOARD_K6 = resolve(ROOT_DIR, 'loadtest/board.k6.js');
const OUTPUT_DIR = resolve(process.env.LOADTEST_OUTPUT_DIR ?? resolve(ROOT_DIR, 'loadtest/runs', new Date().toISOString().replaceAll(':', '-') + '-' + randomUUID().slice(0, 8)));


function runK6(scenario: 'realistic' | 'stress', port: number, isRerun = false): Promise<{ code: number; summaryFile: string; rawFile: string }> {
  const suffix = isRerun ? '-rerun' : '';
  const summaryFile = resolve(OUTPUT_DIR, `summary-${scenario}${suffix}.json`);
  const rawFile = resolve(OUTPUT_DIR, `raw-${scenario}${suffix}.json`);

  console.info(`\n========================================================`);
  console.info(`Running k6 scenario: ${scenario.toUpperCase()}${isRerun ? ' (CONTROLLED RERUN)' : ''}`);
  console.info(`VUs: 100, Think time: ${scenario === 'realistic' ? '1s' : '0s'}, Duration: 60s`);
  console.info(`Output summary: ${summaryFile}`);
  console.info(`Output raw: ${rawFile}`);
  console.info(`========================================================\n`);

  const args = [
    'run',
    `--summary-export=${summaryFile}`,
    `--out=json=${rawFile}`,
    BOARD_K6,
  ];

  const env = {
    ...process.env,
    BASE_URL: `http://127.0.0.1:${port}`,
    HACKATHON_ID: SEED_HACKATHON_ID,
    SCENARIO: scenario,
  };

  return new Promise((resolvePromise, reject) => {
    const proc = spawn(k6Command(), args, { cwd: ROOT_DIR, stdio: 'inherit', env });
    proc.on('error', reject);
    proc.on('close', (code) => {
      resolvePromise({ code: code ?? 1, summaryFile, rawFile });
    });
  });
}

function startClockMonitor(): { stop: () => { jumps: Array<{ time: string; deltaMs: number; prevDiff: number; newDiff: number }> } } {
  let prevDiff = Date.now() - performance.now();
  const jumps: Array<{ time: string; deltaMs: number; prevDiff: number; newDiff: number }> = [];

  const timer = setInterval(() => {
    const currDiff = Date.now() - performance.now();
    const step = currDiff - prevDiff;
    if (Math.abs(step) > 100) {
      const entry = {
        time: new Date().toISOString(),
        deltaMs: Number(step.toFixed(2)),
        prevDiff: Number(prevDiff.toFixed(2)),
        newDiff: Number(currDiff.toFixed(2)),
      };
      jumps.push(entry);
      console.warn(`[CLOCK PROBE] Wall-clock step detected during load test: delta=${entry.deltaMs}ms at ${entry.time}`);
      prevDiff = currDiff;
    }
  }, 100);

  return {
    stop: () => {
      clearInterval(timer);
      return { jumps };
    },
  };
}

async function main() {
  const isRerun = process.argv.includes('--rerun');
  const args = process.argv.slice(2).filter((arg) => arg !== '--rerun');
  const target = args[0] ?? 'both';
  if (args.length > 1 || !['both', 'realistic', 'stress'].includes(target)) throw new Error('Use realistic, stress or both, optionally --rerun.');
  if (!existsSync(TOKENS_PATH)) throw new Error('Tokens missing. Run SEED_DEMO=true npm run seed against a demo/test database first.');
  const version = execFileSync(k6Command(), ['version'], { encoding: 'utf8' }).trim();
  const config = readConfig();
  const pool = createPool(config);
  const scenarios: Array<'realistic' | 'stress'> = target === 'both' ? ['realistic', 'stress'] : [target as 'realistic' | 'stress'];
  const metadata: Record<string, unknown> = {
    startedAt: new Date().toISOString(),
    commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT_DIR, encoding: 'utf8' }).trim(),
    dirtyWorkingTree: !!execFileSync('git', ['status', '--porcelain'], { cwd: ROOT_DIR, encoding: 'utf8' }).trim(),
    node: process.version, kernel: release(), cpu: cpus()[0]?.model, environment: 'local', k6: version,
    poolMax: config.PG_POOL_MAX, readLimitPerUserMinute: 600, cacheTtlMs: 1000,
    warmupSeconds: 10, measurementSeconds: 60, vus: 100,
    trafficMix: { firstPage: .7, skillFiltered: .2, secondPage: .1 },
    runs: [], performanceGatePassed: false,
  };
  let server: ChildProcess | undefined;
  let clockMonitor: ReturnType<typeof startClockMonitor> | undefined;
  await mkdir(OUTPUT_DIR, { recursive: true });
  try {
    metadata.postgres = (await pool.query("SELECT current_setting('server_version') AS version")).rows[0].version;
    const dataset = (await pool.query(`SELECT
      (SELECT count(*)::int FROM hackathon_participants WHERE hackathon_id=$1) AS participants,
      (SELECT count(*)::int FROM teams WHERE hackathon_id=$1) AS teams,
      (SELECT count(*)::int FROM team_members WHERE hackathon_id=$1) AS memberships`, [SEED_HACKATHON_ID])).rows[0];
    metadata.dataset = dataset;
    if (dataset.participants !== 10000 || dataset.teams !== 2000 || dataset.memberships !== 4900) throw new Error('The benchmark requires the documented 10,000-user / 2,000-team / 4,900-membership seed.');
    const started = await startServer(); server = started.server; metadata.localPort = started.port;
    clockMonitor = startClockMonitor();
    let failedCode = 0;
    for (const scenario of scenarios) {
      const result = await runK6(scenario, started.port, isRerun);
      (metadata.runs as unknown[]).push({ scenario, thinkSeconds: scenario === 'realistic' ? 1 : 0, ...result });
      if (result.code !== 0) failedCode = result.code;
      if (!existsSync(result.summaryFile)) throw new Error('k6 did not produce a fresh summary.');
      const summary = JSON.parse(await readFile(result.summaryFile, 'utf8'));
      const duration = summary.metrics?.['successful_board_duration{phase:measurement}'];
      const min = duration?.values?.min ?? duration?.min;
      if (typeof min !== 'number' || min < 0) {
        metadata.invalidHttpTiming = true; failedCode ||= 1;
      }
    }
    const clockData = clockMonitor.stop(); clockMonitor = undefined;
    metadata.clockChanges = clockData.jumps.length;
    await writeFile(resolve(OUTPUT_DIR, 'clock-probe.json'), JSON.stringify(clockData, null, 2));
    if (clockData.jumps.length) {
      failedCode ||= 1;
      console.error('Clock steps observed; this run cannot establish a reliable latency pass.');
    }
    const checks = await checkInvariants(pool, SEED_HACKATHON_ID);
    await writeFile(resolve(OUTPUT_DIR, 'invariants.json'), JSON.stringify(checks, null, 2));
    if (checks.some((check) => check.violations.length)) throw new Error('Database invariant violations after load testing.');
    requireK6Success(failedCode);
    metadata.performanceGatePassed = true;
  } finally {
    if (clockMonitor) {
      const clockData = clockMonitor.stop(); metadata.clockChanges = clockData.jumps.length;
      await writeFile(resolve(OUTPUT_DIR, 'clock-probe.json'), JSON.stringify(clockData, null, 2));
    }
    try { if (server) await stopServer(server); }
    finally {
      await pool.end();
      metadata.completedAt = new Date().toISOString();
      await writeFile(resolve(OUTPUT_DIR, 'metadata.json'), JSON.stringify(metadata, null, 2));
      console.info(`Evidence: ${OUTPUT_DIR}`);
    }
  }
}

main().catch((err) => {
  console.error('Loadtest runner failed:', err);
  process.exit(1);
});
