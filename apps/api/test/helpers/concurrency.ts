import { setImmediate } from 'node:timers/promises';
import type { Pool } from 'pg';

export async function fireAtOnce<T>(jobs: Array<() => Promise<T>>): Promise<T[]> {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const running = jobs.map(async (job) => { await gate; return job(); });
  release();
  // Drain every request even on failure, before teardown can drop a fixture schema.
  const results = await Promise.allSettled(running);
  const failures = results.filter((result) => result.status === 'rejected');
  if (failures.length) throw new AggregateError(failures.map((result) => result.reason), 'Concurrent requests failed.');
  return results.map((result) => (result as PromiseFulfilledResult<T>).value);
}

export async function waitFor(check: () => boolean | Promise<boolean>, description: string, timeoutMs = 1500) {
  const deadline = performance.now() + timeoutMs;
  while (!await check()) {
    if (performance.now() >= deadline) throw new Error(`Timed out waiting for ${description}.`);
    await setImmediate(); // Yield; the observed database condition establishes ordering.
  }
}

export async function waitForBlock(pool: Pool, waiterPid: number, blockerPid: number) {
  await waitFor(async () => (await pool.query<{ blocked: boolean }>(
    'SELECT $1::integer = ANY(pg_blocking_pids($2::integer)) AS blocked', [blockerPid, waiterPid])).rows[0]!.blocked,
  'the second transaction to block on the first');
}
