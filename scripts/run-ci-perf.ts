import { startServer, stopServer, k6Command } from './benchmark-process.js';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { SEED_HACKATHON_ID } from './seed.js';

const ROOT_DIR = resolve(import.meta.dirname, '..');
const TOKENS_PATH = resolve(ROOT_DIR, 'loadtest/tokens.json');
const CI_SMOKE_K6 = resolve(ROOT_DIR, 'loadtest/ci-smoke.k6.js');


async function runSmoke(port: number): Promise<number> {
  const summaryFile = resolve(ROOT_DIR, 'loadtest/summary-ci.json');
  const k6Cmd = k6Command();

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
    throw new Error('Tokens missing. Run SEED_DEMO=true npm run seed against a demo/test database first.');
  }

  const { server, port } = await startServer();

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
