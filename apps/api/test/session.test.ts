import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

it('issues a valid seven-day session even when the clock crosses a second between claim assignments', async () => {
  // Confine clock simulation to its own process so it cannot affect concurrent
  // HTTP fixtures, token verification or database lock-wait coordination.
  const script = `
    import assert from 'node:assert/strict';
    import { randomUUID } from 'node:crypto';
    import { decodeJwt } from 'jose';
    import { createSessions } from ${JSON.stringify(new URL('../src/modules/auth/session.ts', import.meta.url).href)};
    const RealDate = Date;
    let clock = RealDate.now();
    const tick = () => { const now = clock; clock += 1000; return now; };
    globalThis.Date = class extends RealDate {
      constructor() { super(tick()); }
      static now() { return tick(); }
    };
    const sessions = createSessions({ JWT_SECRET: 'clock-boundary-test-secret-0123456789abcdef', NODE_ENV: 'test' });
    const id = randomUUID(); const token = await sessions.issue(id);
    const claims = decodeJwt(token);
    assert.equal(claims.exp - claims.iat, 604800);
    assert.equal(await sessions.read({ headers: { cookie: 'sid=' + token } }), id);
  `;
  const result = await promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script]);
  expect(result.stderr).toBe('');
});
