import { createHash } from 'node:crypto';
import { AppError } from '../db/errors.js';

export interface RateLimiter {
  reserve(key: string, limit: number, windowMs: number): () => void;
}

type Entry = { at: number };
type Bucket = { entries: Entry[]; windowMs: number };

// A reservation counts in-flight logins so concurrent failures cannot bypass the cap.
// Calling the returned function removes only that reservation (successful login).
export class SlidingWindowLimiter implements RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private nextSweep = 0;
  constructor(private readonly now = Date.now, private readonly maxKeys = 50_000) {}

  reserve(key: string, limit: number, windowMs: number): () => void {
    const now = this.now();
    if (now >= this.nextSweep) {
      for (const [id, bucket] of this.buckets) {
        bucket.entries = bucket.entries.filter((entry) => entry.at > now - bucket.windowMs);
        if (bucket.entries.length === 0) this.buckets.delete(id);
      }
      this.nextSweep = now + 30_000;
    }
    const bucket = this.buckets.get(key) ?? { entries: [], windowMs };
    bucket.entries = bucket.entries.filter((entry) => entry.at > now - windowMs);
    if (bucket.entries.length >= limit) {
      const retryAfter = Math.max(1, Math.ceil((bucket.entries[0]!.at + windowMs - now) / 1000));
      throw new AppError('RATE_LIMITED', 429, 'Too many requests. Please try again later.', retryAfter);
    }
    if (!this.buckets.has(key) && this.buckets.size >= this.maxKeys) {
      throw new AppError('RATE_LIMITED', 429, 'Too many requests. Please try again later.', 30);
    }
    const entry = { at: now };
    bucket.entries.push(entry);
    this.buckets.set(key, bucket);
    return () => {
      bucket.entries = bucket.entries.filter((item) => item !== entry);
      if (bucket.entries.length === 0 && this.buckets.get(key) === bucket) this.buckets.delete(key);
    };
  }
}

export function privateRateKey(prefix: string, value: string) {
  return `${prefix}:${createHash('sha256').update(value).digest('hex')}`;
}
