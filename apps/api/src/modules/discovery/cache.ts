import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { busyError } from '../../db/errors.js';

export type Representation = { json: string; gzip: Buffer; etag: string };
type Entry = { hid: string; expires: number; value: Representation };
type Flight = { hid: string; generation: number; promise: Promise<Representation> };

export class BoardCache {
  private entries = new Map<string, Entry>();
  private flights = new Map<string, Flight>();
  private generations = new Map<string, number>();
  private sequence = 0;
  constructor(private readonly now = () => performance.now(), private readonly capacity = 500, private readonly ttl = 1000) {}
  invalidate(hid: string) {
    if (this.generations.has(hid)) this.generations.set(hid, ++this.sequence);
    for (const [key, entry] of this.entries) if (entry.hid === hid) this.entries.delete(key);
    this.prune(hid);
  }
  private prune(hid: string) {
    if (![...this.entries.values(), ...this.flights.values()].some((entry) => entry.hid === hid)) this.generations.delete(hid);
  }
  async get(hid: string, query: unknown, load: () => Promise<unknown>): Promise<Representation> {
    const key = JSON.stringify([hid, query]);
    const entry = this.entries.get(key);
    if (entry && entry.expires > this.now()) {
      this.entries.delete(key); this.entries.set(key, entry); return entry.value;
    }
    if (entry) this.entries.delete(key);
    const generation = this.generations.get(hid) ?? ++this.sequence;
    this.generations.set(hid, generation);
    const pending = this.flights.get(key);
    if (pending?.generation === generation) return pending.promise;
    if (this.flights.size >= this.capacity) { this.prune(hid); throw busyError(); }
    const flight: Flight = { hid, generation, promise: Promise.resolve().then(load).then((data) => {
      const json = JSON.stringify(data);
      const value = { json, gzip: gzipSync(json), etag: `W/"${createHash('sha256').update(json).digest('base64url')}"` };
      if (this.generations.get(hid) === generation) {
        this.entries.set(key, { hid, expires: this.now() + this.ttl, value });
        while (this.entries.size > this.capacity) {
          const oldest = this.entries.entries().next().value!;
          this.entries.delete(oldest[0]); this.prune(oldest[1].hid);
        }
      }
      return value;
    }).finally(() => { if (this.flights.get(key) === flight) this.flights.delete(key); this.prune(hid); }) };
    this.flights.set(key, flight);
    return flight.promise;
  }
}
