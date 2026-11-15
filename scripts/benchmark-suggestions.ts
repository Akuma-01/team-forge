import { spawn, type ChildProcess } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createPool } from '../apps/api/src/db/pool.js';
import { readConfig } from '../apps/api/src/config.js';
import { scoreCandidate } from '../apps/api/src/modules/discovery/scoring.js';
import type { Skill } from '@teamforge/shared';

const ROOT_DIR = resolve(import.meta.dirname, '..');
const HACKATHON_ID = '00000000-0000-4000-a000-000000000001';
const TEAM_ID = '00000001-0000-4000-b000-000000000001';
const TOKENS_PATH = resolve(ROOT_DIR, 'loadtest/tokens.json');

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(index, sorted.length - 1))]!;
}

function stats(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    count: sorted.length,
    min: Number(sorted[0]?.toFixed(2) ?? 0),
    max: Number(sorted[sorted.length - 1]?.toFixed(2) ?? 0),
    avg: Number((sum / sorted.length).toFixed(2)),
    p50: Number(percentile(sorted, 50).toFixed(2)),
    p90: Number(percentile(sorted, 90).toFixed(2)),
    p95: Number(percentile(sorted, 95).toFixed(2)),
    p99: Number(percentile(sorted, 99).toFixed(2)),
  };
}

async function waitForServer(url: string, timeoutMs = 15000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.status === 200) return;
    } catch {
      // not ready
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Server failed to respond at ${url}`);
}

async function startServer(): Promise<{ server: ChildProcess; port: number }> {
  const port = 8081;
  const server = spawn('node', ['--env-file-if-exists=.env', 'apps/api/dist/server.js'], {
    cwd: ROOT_DIR,
    stdio: 'ignore',
    env: { ...process.env, PORT: String(port) },
  });
  await waitForServer(`http://127.0.0.1:${port}/ready`);
  return { server, port };
}

async function stopServer(server: ChildProcess): Promise<void> {
  if (server.killed || server.exitCode !== null) return;
  server.kill('SIGTERM');
  await new Promise<void>((res) => {
    server.once('exit', () => res());
    setTimeout(() => { server.kill('SIGKILL'); res(); }, 3000);
  });
}

async function main() {
  console.info('Starting suggestions benchmark against 10,000-user seeded database...\n');
  const config = readConfig();
  const pool = createPool(config);

  const tokens = JSON.parse(await readFile(TOKENS_PATH, 'utf-8')) as string[];
  const leaderToken = tokens[0]!;

  // 1. Run EXPLAIN (ANALYZE, BUFFERS) on candidate query
  console.info('1. Running EXPLAIN (ANALYZE, BUFFERS) on candidate retrieval query...');
  const candidateQuery = `
    SELECT u.id, u.display_name, u.skills, u.utc_offset_min
    FROM hackathon_participants p
    JOIN users u ON u.id = p.user_id
    WHERE p.hackathon_id = $1 AND p.open_to_invites AND NOT EXISTS (
      SELECT 1 FROM team_members m WHERE m.hackathon_id = p.hackathon_id AND m.user_id = p.user_id
    )
    ORDER BY u.id
    LIMIT 10000;
  `;

  const explainRes = await pool.query<{ 'QUERY PLAN': string }>(
    `EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) ${candidateQuery}`,
    [HACKATHON_ID],
  );
  const explainPlan = explainRes.rows.map((r) => r['QUERY PLAN']).join('\n');
  console.info('Query Plan:\n' + explainPlan + '\n');

  // 2. Profile direct components over 100 iterations
  console.info('2. Profiling internal pipeline components over 100 runs...');
  const candidateDbTimes: number[] = [];
  const candidateRowsCounts: number[] = [];
  const scoringTimes: number[] = [];
  const sortSliceTimes: number[] = [];
  const totalInternalTimes: number[] = [];

  const teamRes = await pool.query<{ looking_for: Skill[] }>('SELECT looking_for FROM teams WHERE id = $1', [TEAM_ID]);
  const needs = teamRes.rows[0]!.looking_for;
  const membersRes = await pool.query<{ skills: Skill[]; utc_offset_min: number }>(
    'SELECT u.skills, u.utc_offset_min FROM team_members m JOIN users u ON u.id = m.user_id WHERE m.team_id = $1',
    [TEAM_ID],
  );
  const teamSkills = [...new Set(membersRes.rows.flatMap((r) => r.skills))];
  const offsets = membersRes.rows.map((r) => r.utc_offset_min).sort((a, b) => a - b);
  const reference = offsets[Math.floor(offsets.length / 2)] ?? 0;

  for (let i = 0; i < 100; i++) {
    const t0 = performance.now();
    const candidatesRes = await pool.query<{ id: string; display_name: string; skills: Skill[]; utc_offset_min: number }>(
      candidateQuery,
      [HACKATHON_ID],
    );
    const t1 = performance.now();

    const tScore0 = performance.now();
    const scored = candidatesRes.rows.map((r) => {
      const breakdown = scoreCandidate(teamSkills, needs, reference, r.skills, r.utc_offset_min);
      return {
        userId: r.id,
        displayName: r.display_name,
        skills: r.skills,
        utcOffsetMin: r.utc_offset_min,
        score: breakdown.total,
        breakdown,
      };
    });
    const tScore1 = performance.now();

    const tSort0 = performance.now();
    scored.sort((a, b) => b.score - a.score || a.userId.localeCompare(b.userId)).slice(0, 20);
    const tSort1 = performance.now();

    candidateDbTimes.push(t1 - t0);
    candidateRowsCounts.push(candidatesRes.rowCount ?? 0);
    scoringTimes.push(tScore1 - tScore0);
    sortSliceTimes.push(tSort1 - tSort0);
    totalInternalTimes.push(performance.now() - t0);
  }

  // 3. HTTP End-to-End Latency Benchmark over 100 requests
  console.info('3. Measuring end-to-end HTTP latency over 100 requests...');
  const { server, port } = await startServer();
  const httpTimes: number[] = [];
  let sampleResponse: unknown;

  try {
    const url = `http://127.0.0.1:${port}/api/hackathons/${HACKATHON_ID}/teams/${TEAM_ID}/suggestions`;
    for (let i = 0; i < 100; i++) {
      const t0 = performance.now();
      const res = await fetch(url, {
        headers: {
          Cookie: `sid=${leaderToken}`,
          Accept: 'application/json',
        },
      });
      const t1 = performance.now();
      if (res.status !== 200) {
        throw new Error(`HTTP request failed with status ${res.status}`);
      }
      if (i === 0) {
        sampleResponse = await res.json();
      } else {
        await res.text();
      }
      httpTimes.push(t1 - t0);
    }
  } finally {
    await stopServer(server);
    await pool.end();
  }

  const results = {
    hackathonId: HACKATHON_ID,
    teamId: TEAM_ID,
    candidateRowsScored: candidateRowsCounts[0] ?? 0,
    metrics: {
      candidateQueryDbMs: stats(candidateDbTimes),
      inMemoryScoringMs: stats(scoringTimes),
      sortAndSliceMs: stats(sortSliceTimes),
      totalInternalPipelineMs: stats(totalInternalTimes),
      httpEndToEndMs: stats(httpTimes),
    },
    explainPlan,
    sampleTopMatchesCount: Array.isArray((sampleResponse as { items?: unknown[] })?.items)
      ? (sampleResponse as { items: unknown[] }).items.length
      : 0,
  };

  const outputPath = resolve(ROOT_DIR, 'loadtest/suggestions-benchmark.json');
  await writeFile(outputPath, JSON.stringify(results, null, 2), 'utf-8');
  console.info(`Saved benchmark results to ${outputPath}\n`);

  console.info('=== SUGGESTIONS BENCHMARK RESULTS (100 runs, 5,100 candidates scored) ===');
  console.info(`Candidate Rows: ${results.candidateRowsScored}`);
  console.info(`Database Query Time: p50=${results.metrics.candidateQueryDbMs.p50}ms, p95=${results.metrics.candidateQueryDbMs.p95}ms, p99=${results.metrics.candidateQueryDbMs.p99}ms`);
  console.info(`In-Memory Scoring Time: p50=${results.metrics.inMemoryScoringMs.p50}ms, p95=${results.metrics.inMemoryScoringMs.p95}ms, p99=${results.metrics.inMemoryScoringMs.p99}ms`);
  console.info(`Sort & Slice Time: p50=${results.metrics.sortAndSliceMs.p50}ms, p95=${results.metrics.sortAndSliceMs.p95}ms, p99=${results.metrics.sortAndSliceMs.p99}ms`);
  console.info(`Total Internal Time: p50=${results.metrics.totalInternalPipelineMs.p50}ms, p95=${results.metrics.totalInternalPipelineMs.p95}ms, p99=${results.metrics.totalInternalPipelineMs.p99}ms`);
  console.info(`HTTP End-to-End Latency: p50=${results.metrics.httpEndToEndMs.p50}ms, p95=${results.metrics.httpEndToEndMs.p95}ms, p99=${results.metrics.httpEndToEndMs.p99}ms`);
}

main().catch((err) => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
