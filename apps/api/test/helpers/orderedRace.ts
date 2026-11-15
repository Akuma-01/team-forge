import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import type { QueryObservation, QueryObserver } from './observePool.js';
import type { RaceFixture, RaceResponse } from './raceFixture.js';
import { bounded, signal } from './signals.js';
import { waitForBlock } from './concurrency.js';

export const teamLock = (event: QueryObservation) => event.sql.startsWith('SELECT id, leader_id') && event.sql.endsWith('FOR UPDATE');
export const participantLock = (event: QueryObservation) => event.sql.includes('hackathon_participants') && event.sql.endsWith('FOR NO KEY UPDATE');
export const decisionWrite = (event: QueryObservation) => event.sql.startsWith('UPDATE join_requests SET status=$3');
export const cancellationWrite = (event: QueryObservation) => event.sql.trimStart().startsWith('WITH cancelled AS');

// Idempotency keys label requests even when two actions have the same actor, or
// when an actor locks somebody else's participant row (accept/remove).
export function orderedRace(firstLocked = teamLock, secondWaiting = teamLock) {
  const firstKey = randomUUID(); const secondKey = randomUUID();
  const owner = new Map<number, unknown>();
  const locked = signal(); const waiting = signal(); const release = signal();
  let firstPid = 0; let secondPid = 0;
  const observe: QueryObserver = async (event) => {
    if (event.phase === 'before' && event.sql.startsWith('INSERT INTO idempotency_keys')) owner.set(event.checkout, event.params[1]);
    if (owner.get(event.checkout) === firstKey && event.phase === 'after' && firstLocked(event)) {
      firstPid = event.pid; locked.resolve(); await bounded(release.promise);
    }
    if (owner.get(event.checkout) === secondKey && event.phase === 'before' && secondWaiting(event)) {
      secondPid = event.pid; waiting.resolve();
    }
  };
  const run = async (fixture: RaceFixture, first: (key: string) => Promise<RaceResponse>, second: (key: string) => Promise<RaceResponse>) => {
    const started = [first(firstKey)];
    try {
      await bounded(locked.promise);
      started.push(second(secondKey));
      await bounded(waiting.promise);
      expect(firstPid).not.toBe(secondPid);
      await waitForBlock(fixture.observer, secondPid, firstPid);
    } finally { release.resolve(); await Promise.allSettled(started); }
    const results = await Promise.all(started);
    // A rejected contender must not leave behind a replayable intent. Check
    // both keys in every ordered race, alongside the domain assertions.
    const keys = [firstKey, secondKey];
    const retained = await fixture.pool.query<{ key: string; response_status: number }>(
      'SELECT key, response_status FROM idempotency_keys WHERE key=ANY($1::text[]) ORDER BY key', [keys]);
    expect(retained.rows).toEqual(results.flatMap((result, index) => result.status < 300
      ? [{ key: keys[index]!, response_status: result.status }] : []).sort((a, b) => a.key.localeCompare(b.key)));
    return results;
  };
  return { observe, run };
}
