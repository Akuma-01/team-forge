import { describe, expect, it } from 'vitest';
import { SlidingWindowLimiter } from '../src/middleware/rateLimit.js';

describe('sliding-window rate limiter', () => {
  it('expires entries individually, reports remaining wait and isolates keys', () => {
    let now = 0;
    const limiter = new SlidingWindowLimiter(() => now);
    limiter.reserve('a', 2, 10_000);
    now = 5_000; limiter.reserve('a', 2, 10_000);
    expect(() => limiter.reserve('a', 2, 10_000)).toThrow(expect.objectContaining({ status: 429, retryAfter: 5 }));
    expect(() => limiter.reserve('b', 2, 10_000)).not.toThrow();
    now = 10_000;
    expect(() => limiter.reserve('a', 2, 10_000)).not.toThrow();
    expect(() => limiter.reserve('a', 2, 10_000)).toThrow();
    now = 15_000; expect(() => limiter.reserve('a', 2, 10_000)).not.toThrow();
  });
  it('refunds exactly one reservation and is safe to call twice', () => {
    const limiter = new SlidingWindowLimiter(() => 0);
    const release = limiter.reserve('a', 2, 1000);
    limiter.reserve('a', 2, 1000); release(); release();
    limiter.reserve('a', 2, 1000);
    expect(() => limiter.reserve('a', 2, 1000)).toThrow();
  });
  it('bounds memory, refuses new keys without dropping active limits, then sweeps expired keys', () => {
    let now = 0;
    const limiter = new SlidingWindowLimiter(() => now, 2);
    limiter.reserve('a', 1, 1000); limiter.reserve('b', 1, 1000);
    expect(() => limiter.reserve('c', 1, 1000)).toThrow();
    expect(() => limiter.reserve('a', 1, 1000)).toThrow();
    now = 30_000; expect(() => limiter.reserve('c', 1, 1000)).not.toThrow();
  });
});
