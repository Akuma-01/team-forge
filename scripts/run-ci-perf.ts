import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { seed, SEED_HACKATHON_ID } from './seed.js';

const ROOT_DIR = resolve(import.meta.dirname, '..');
const K6_BIN = resolve(ROOT_DIR, 'loadtest/bin/k6');
const TOKENS_PATH = resolve(ROOT_DIR, 'loadtest/tokens.json');
const CI_SMOKE_K6 = resolve(ROOT_DIR, 'loadtest/ci-smoke.k6.js');

async function waitForServer(url: string, timeoutMs = 15000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.status === 200) return;
    } catch {
      // waiting
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Server failed to respond at ${url} within ${timeoutMs}ms`);
}

async function startServer(port = 8080): Promise<{ server: ChildProcess; port: number }> {
  console.info(`Starting API server on port ${port}...`);
  const server = spawn('node', ['--env-file-if-exists=.env', 'apps/api/dist/server.js'], {
    cwd: ROOT_DIR,
    stdio: 'inherit',
    env: { ...process.env, PORT: String(port) },
  });

  await waitForServer(`http://127.0.0.1:${port}/ready`);
  console.info(`API server is ready at http://127.0.0.1:${port}`);
  return { server, port };
}

async function stopServer(server: ChildProcess): Promise<void> {
  if (server.killed || server.exitCode !== null) return;
  console.info('Stopping API server...');
  server.kill('SIGTERM');
  await new Promise<void>((res) => {
    server.once('exit', () => res());
    setTimeout(() => { server.kill('SIGKILL'); res(); }, 3000);
  });
}

function resolveK6Command(): string {
  if (existsSync(K6_BIN)) return K6_BIN;
  return 'k6'; // Fallback to system-installed k6 on CI runner
}

async function runSmoke(port: number): Promise<number> {
  const summaryFile = resolve(ROOT_DIR, 'loadtest/summary-ci.json');
  const k6Cmd = resolveK6Command();

  console.info('\n========================================================');
  console.info('Running k6 CI Performance Smoke Test (20s, 10 VUs)');
  console.info(`Summary Output: ${summaryFile}`);
  console.info('========================================================\n');

  const args = [
    'run',
    `--summary-export=${summaryFile}`,
    CI_SMOKE_K6,
  ];

  const env = {
    ...process.env,
    BASE_URL: `http://127.0.0.1:${port}`,
    HACKATHON_ID: SEED_HACKATHON_ID,
  };

  return new Promise((res, rej) => {
    const proc = spawn(k6Cmd, args, { cwd: ROOT_DIR, stdio: 'inherit', env });
    proc.on('error', rej);
    proc.on('close', (code) => res(code ?? 1));
  });
}

async function main() {
  if (!existsSync(TOKENS_PATH)) {
    console.info('Tokens not found; seeding database first...');
    await seed();
  }

  const port = Number(process.env.PORT || 8080);
  const { server } = await startServer(port);

  let exitCode = 1;
  try {
    exitCode = await runSmoke(port);
  } finally {
    await stopServer(server);
  }

  process.exit(exitCode);
}

main().catch((err) => {
  console.error('CI perf smoke test failed:', err);
  process.exit(1);
});
