import { EventEmitter } from 'node:events';
import type { Response } from 'express';
import { gunzipSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BoardCache } from '../../src/modules/discovery/cache.js';
import { median, scoreCandidate } from '../../src/modules/discovery/scoring.js';
import { StreamHub } from '../../src/modules/discovery/stream.js';

afterEach(() => vi.useRealTimers());
describe('suggestion scoring', () => {
  it('matches both worked examples and explains every component', () => {
    const a = scoreCandidate(['frontend', 'backend'], ['design', 'ml'], 330, ['design', 'frontend'], 360);
    const b = scoreCandidate(['frontend', 'backend'], ['design', 'ml'], 330, ['ml', 'data'], -300);
    expect(a.total).toBe(65); expect(b.total).toBe(42);
    expect(a.skill).toMatchObject({ needCovered: ['design'], newToTeam: ['design'], redundant: ['frontend'], needCoverage: 0.5, complementRatio: 0.5 });
    expect(a.timezone).toMatchObject({ deltaHours: 0.5, overlapHours: 7.5 });
  });
  it('handles empty skills and needs, complementary skills, and circular timezone distance', () => {
    expect(scoreCandidate([], [], 0, [], 0).total).toBe(35);
    expect(scoreCandidate(['frontend'], [], 0, ['design'], 0).total).toBe(100);
    expect(scoreCandidate(['frontend'], [], 0, ['frontend'], 0).total).toBe(35);
    expect(scoreCandidate([], [], 840, [], -720).timezone).toMatchObject({ deltaHours: 2, overlapHours: 6 });
    expect(median([840, -720, 0, 330])).toBe(165);
  });
});
describe('public board cache', () => {
  it('shares loads, serializes/gzips consistently and expires using a monotonic clock', async () => {
    let now = 0; const cache = new BoardCache(() => now); const load = vi.fn(async () => ({ items: ['public'] }));
    const [a,b] = await Promise.all([cache.get('h', {}, load), cache.get('h', {}, load)]);
    expect(load).toHaveBeenCalledTimes(1); expect(a).toBe(b); expect(gunzipSync(a.gzip).toString()).toBe(a.json);
    now = 1001; await cache.get('h', {}, load); expect(load).toHaveBeenCalledTimes(2);
  });
  it('prevents an old in-flight page from repopulating after invalidation', async () => {
    const cache = new BoardCache(); let resolve!: (value: unknown) => void;
    const old = cache.get('h', {}, () => new Promise((done) => { resolve = done; })); await Promise.resolve();
    cache.invalidate('h');
    const fresh = await cache.get('h', {}, async () => ({ value: 'fresh' }));
    resolve({ value: 'old' }); await old;
    expect(await cache.get('h', {}, async () => { throw new Error('Must hit fresh cache'); })).toBe(fresh);
  });
  it('bounds entries by LRU, separates filters/hackathons and does not cache failures', async () => {
    const cache = new BoardCache(() => 0, 2); const load = vi.fn(async () => ({}));
    await cache.get('a', { q: 'x' }, load); await cache.get('b', {}, load); await cache.get('a', { q: 'x' }, load);
    await cache.get('a', { q: 'y' }, load); await cache.get('b', {}, load); expect(load).toHaveBeenCalledTimes(4);
    await expect(cache.get('bad', {}, async () => { throw new Error('database'); })).rejects.toThrow('database');
    await expect(cache.get('bad', {}, async () => 'recovered')).resolves.toMatchObject({ json: '"recovered"' });
  });
});

class Sink extends EventEmitter {
  chunks: string[] = []; destroyed = false; writable = true;
  status() { return this; } set() { return this; } flushHeaders() {}
  write(s: string) { this.chunks.push(s); return this.writable; }
  end() { this.destroyed = true; this.emit('close'); }
  destroy() { this.end(); }
  get response() { return this as unknown as Response; }
}
describe('stream resource lifecycle', () => {
  it('coalesces public events, heartbeats, expires and shuts down with bye', async () => {
    vi.useFakeTimers(); const hub = new StreamHub(); const sink = new Sink();
    hub.connect(sink.response, 'u', 'h', Date.now() + 60_000);
    hub.changed('h'); hub.changed('h'); hub.changed('other'); await vi.advanceTimersByTimeAsync(250);
    expect(sink.chunks.filter((s) => s.includes('state.changed'))).toEqual(['event: state.changed\ndata: {"hackathonId":"h"}\n\n']);
    await vi.advanceTimersByTimeAsync(19_750); expect(sink.chunks).toContain(': heartbeat\n\n');
    hub.close(); expect(sink.chunks.at(-1)).toBe('event: bye\ndata: {}\n\n'); expect(sink.destroyed).toBe(true);
    const another = new StreamHub(); const expiring = new Sink(); another.connect(expiring.response, 'u', 'h', Date.now() + 100);
    await vi.advanceTimersByTimeAsync(100); expect(expiring.destroyed).toBe(true); another.close();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('caps users/process and releases capacity when sockets close', () => {
    vi.useFakeTimers(); const hub = new StreamHub(4); const sinks = Array.from({ length: 4 }, () => new Sink());
    for (const s of sinks.slice(0,3)) hub.connect(s.response, 'u', 'h', Date.now()+60_000);
    expect(() => hub.connect(new Sink().response, 'u', 'h', Date.now()+60_000)).toThrow('Too many');
    hub.connect(sinks[3]!.response, 'other', 'h', Date.now()+60_000);
    expect(() => hub.connect(new Sink().response, 'third', 'h', Date.now()+60_000)).toThrow('Too many');
    sinks[0]!.end(); hub.connect(new Sink().response, 'u', 'h', Date.now()+60_000); hub.close();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('bounds backpressure, recovers on drain and drops a persistently slow socket', async () => {
    vi.useFakeTimers(); const hub = new StreamHub(); const sink = new Sink(); sink.writable = false;
    hub.connect(sink.response, 'u', 'h', Date.now()+60_000); hub.changed('h'); await vi.advanceTimersByTimeAsync(250);
    expect(sink.chunks).toHaveLength(1);
    sink.writable = true; sink.emit('drain'); expect(sink.chunks.at(-1)).toContain('state.changed');
    sink.writable = false; hub.changed('h'); await vi.advanceTimersByTimeAsync(5250);
    expect(sink.destroyed).toBe(true); hub.close(); expect(vi.getTimerCount()).toBe(0);
  });
});
