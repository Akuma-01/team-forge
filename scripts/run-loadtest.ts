import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { checkInvariants } from '../apps/api/src/db/invariants.js';
import { createPool } from '../apps/api/src/db/pool.js';
import { readConfig } from '../apps/api/src/config.js';
import { SEED_HACKATHON_ID, seed } from './seed.js';

const ROOT_DIR = resolve(import.meta.dirname, '..');
const K6_BIN = resolve(ROOT_DIR, 'loadtest/bin/k6');
const TOKENS_PATH = resolve(ROOT_DIR, 'loadtest/tokens.json');
const BOARD_K6 = resolve(ROOT_DIR, 'loadtest/board.k6.js');

async function waitForServer(url: string, timeoutMs = 15000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.status === 200) return;
    } catch {
      // Server not ready yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Server failed to respond at ${url} within ${timeoutMs}ms`);
}

async function startServer(): Promise<{ server: ChildProcess; port: number }> {
  const port = 8080;
  console.info(`Starting API server on port ${port}...`);

  const server = spawn('node', ['--env-file-if-exists=.env', 'apps/api/dist/server.js'], {
    cwd: ROOT_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(port) },
  });

  server.stdout?.on('data', (d) => {
    const line = d.toString().trim();
    if (line) console.log(`[server] ${line}`);
  });

  server.stderr?.on('data', (d) => {
    const line = d.toString().trim();
    if (line) console.error(`[server err] ${line}`);
  });

  await waitForServer(`http://127.0.0.1:${port}/ready`);
  console.info(`API server is ready at http://127.0.0.1:${port}`);
  return { server, port };
}

async function stopServer(server: ChildProcess): Promise<void> {
  if (server.killed || server.exitCode !== null) return;
  console.info('Stopping API server gracefully...');
  server.kill('SIGTERM');
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      server.kill('SIGKILL');
      resolve();
    }, 5000);
    server.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

function runK6(scenario: 'realistic' | 'stress', port: number, isRerun = false): Promise<{ code: number; summaryFile: string; rawFile: string }> {
  const suffix = isRerun ? '-rerun' : '';
  const summaryFile = resolve(ROOT_DIR, `loadtest/summary-${scenario}${suffix}.json`);
  const rawFile = resolve(ROOT_DIR, `loadtest/raw-${scenario}${suffix}.json`);

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
    const proc = spawn(K6_BIN, args, { cwd: ROOT_DIR, stdio: 'inherit', env });
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
  const nonFlagArgs = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
  const targetScenario = nonFlagArgs[0]?.toLowerCase() || 'both';

  // Ensure tokens.json exists
  if (!existsSync(TOKENS_PATH)) {
    console.info('Tokens file not found; running database seed first...');
    await seed();
  }

  // Ensure k6 binary exists
  if (!existsSync(K6_BIN)) {
    throw new Error(`k6 binary not found at ${K6_BIN}`);
  }

  const { server, port } = await startServer();
  const scenariosToRun: Array<'realistic' | 'stress'> =
    targetScenario === 'realistic' ? ['realistic']
    : targetScenario === 'stress' ? ['stress']
    : ['realistic', 'stress'];

  const results: Record<string, Record<string, unknown>> = {};

  const clockMonitor = isRerun ? startClockMonitor() : null;

  try {
    for (const sc of scenariosToRun) {
      const res = await runK6(sc, port, isRerun);
      if (existsSync(res.summaryFile)) {
        const rawSummary = await readFile(res.summaryFile, 'utf-8');
        results[sc] = JSON.parse(rawSummary);
      }
    }

    if (clockMonitor) {
      const clockData = clockMonitor.stop();
      const clockPath = resolve(ROOT_DIR, 'loadtest/clock-probe-stress-rerun.json');
      await writeFile(clockPath, JSON.stringify(clockData, null, 2), 'utf-8');
      console.info(`Saved clock jump telemetry to ${clockPath} (${clockData.jumps.length} jumps observed)`);
    }

    // Only update default loadtest/summary.json if not a specific rerun
    if (!isRerun) {
      if (results.realistic) {
        await writeFile(resolve(ROOT_DIR, 'loadtest/summary.json'), JSON.stringify(results.realistic, null, 2), 'utf-8');
      } else if (results.stress) {
        await writeFile(resolve(ROOT_DIR, 'loadtest/summary.json'), JSON.stringify(results.stress, null, 2), 'utf-8');
      }
    }
  } finally {
    if (clockMonitor) clockMonitor.stop();
    await stopServer(server);
  }

  // Task 2 requirement: Run invariant checker after performance testing
  console.info('\nVerifying database invariants after load testing...');
  const config = readConfig();
  const pool = createPool(config);
  try {
    const checks = await checkInvariants(pool, SEED_HACKATHON_ID);
    const postTestFilename = isRerun ? 'loadtest/invariants-post-rerun.json' : 'loadtest/invariants-post-test.json';
    const postTestPath = resolve(ROOT_DIR, postTestFilename);
    await writeFile(postTestPath, JSON.stringify(checks, null, 2), 'utf-8');
    console.info(`Saved post-test invariant checks to ${postTestPath}`);

    const hasViolations = checks.some((c) => c.violations.length > 0);
    if (hasViolations) {
      console.error('INVARIANT VIOLATIONS DETECTED AFTER LOAD TEST!');
      process.exitCode = 1;
    } else {
      console.info('All 8 database invariants passed post-load-test with 0 violations!');
    }
  } finally {
    await pool.end();
  }

  console.info('\nLoad test execution complete.');
}

main().catch((err) => {
  console.error('Loadtest runner failed:', err);
  process.exit(1);
});
