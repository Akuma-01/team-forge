import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';

console.info('=== Production Readiness Verification ===');

const env = {
  ...process.env,
  NODE_ENV: 'production',
  HOST: '127.0.0.1',
  PORT: '8085',
  APP_ORIGIN: 'https://teamforge.onrender.com',
};

const server = spawn('node', ['apps/api/dist/server.js'], {
  cwd: process.cwd(),
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
});

let serverLogs = '';
server.stdout?.on('data', (d) => { serverLogs += d.toString(); });
server.stderr?.on('data', (d) => { serverLogs += d.toString(); });

async function runTests() {
  try {
    // 1. Wait for server startup and migration on boot
    console.info('1. Verifying server startup and migration...');
    let ready = false;
    for (let i = 0; i < 40; i++) {
      try {
        const res = await fetch('http://127.0.0.1:8085/health');
        if (res.status === 200) { ready = true; break; }
      } catch {
        // waiting
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    assert.equal(ready, true, 'Server must start and answer /health');
    assert.match(serverLogs, /migrations\.complete/, 'Server must report migrations.complete on boot');
    assert.match(serverLogs, /server\.started/, 'Server must report server.started on boot');
    console.info('✓ Server started and completed migration check on boot');

    // 2. Health and Ready endpoints
    console.info('2. Verifying /health and /ready endpoints...');
    const healthRes = await fetch('http://127.0.0.1:8085/health');
    assert.equal(healthRes.status, 200);
    assert.equal(healthRes.headers.get('cache-control'), 'no-store');
    const healthJson = await healthRes.json();
    assert.deepEqual(healthJson, { status: 'ok' });

    const readyRes = await fetch('http://127.0.0.1:8085/ready');
    assert.equal(readyRes.status, 200);
    assert.equal(readyRes.headers.get('cache-control'), 'no-store');
    const readyJson = await readyRes.json();
    assert.deepEqual(readyJson, { status: 'ok' });
    console.info('✓ /health and /ready return 200 with no-store cache headers');

    // 3. Production static frontend serving
    console.info('3. Verifying static frontend serving and SPA fallback...');
    const rootRes = await fetch('http://127.0.0.1:8085/');
    assert.equal(rootRes.status, 200);
    const rootHtml = await rootRes.text();
    assert.match(rootHtml, /id="root"/, 'index.html must contain root element');

    // SPA routing check (e.g. /board or /hackathons/any)
    const spaRes = await fetch('http://127.0.0.1:8085/board', {
      headers: { Accept: 'text/html' },
    });
    assert.equal(spaRes.status, 200);
    assert.equal(spaRes.headers.get('cache-control'), 'no-cache');
    const spaHtml = await spaRes.text();
    assert.match(spaHtml, /id="root"/, 'SPA route must return index.html fallback');
    console.info('✓ Static frontend served and SPA fallback behaves correctly');

    // 4. Same-origin API configuration
    console.info('4. Verifying same-origin API enforcement...');
    // A mutating POST request from disallowed origin should get 403 FORBIDDEN
    const forbiddenRes = await fetch('http://127.0.0.1:8085/api/auth/logout', {
      method: 'POST',
      headers: { Origin: 'https://malicious-site.com', 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(forbiddenRes.status, 403, 'Disallowed origin must return 403');
    const forbiddenJson = await forbiddenRes.json();
    assert.equal(forbiddenJson.error.code, 'FORBIDDEN');

    // Mutating request with allowed APP_ORIGIN
    const allowedRes = await fetch('http://127.0.0.1:8085/api/auth/logout', {
      method: 'POST',
      headers: { Origin: 'https://teamforge.onrender.com', 'Content-Type': 'application/json' },
      body: '{}',
    });
    // Should pass origin check (returns 204 or unauthenticated/allowed status, not 403)
    assert.notEqual(allowedRes.status, 403, 'Matching origin must pass origin check');
    console.info('✓ Mutating API endpoints enforce APP_ORIGIN match (403 on mismatch)');

    // 5. Production cookie configuration
    console.info('5. Verifying production cookie security (Secure, HttpOnly, SameSite=Lax)...');
    const testEmail = `prod_test_${Date.now()}@example.com`;
    const signupRes = await fetch('http://127.0.0.1:8085/api/auth/signup', {
      method: 'POST',
      headers: {
        Origin: 'https://teamforge.onrender.com',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email: testEmail,
        password: 'Password123!',
        displayName: 'Prod Test User',
      }),
    });
    assert.equal(signupRes.status, 201, 'Signup should succeed');
    const setCookie = signupRes.headers.get('set-cookie');
    assert.ok(setCookie, 'Signup must set cookie');
    assert.match(setCookie, /HttpOnly/i, 'Cookie must have HttpOnly');
    assert.match(setCookie, /Secure/i, 'Cookie must have Secure in production');
    assert.match(setCookie, /SameSite=Lax/i, 'Cookie must have SameSite=Lax');
    assert.match(setCookie, /Path=\//i, 'Cookie must have Path=/');
    console.info('✓ Session cookie sets HttpOnly, Secure, SameSite=Lax, Path=/ in production');

    // 6. Graceful shutdown
    console.info('6. Verifying graceful shutdown on SIGTERM...');
    const shutdownPromise = new Promise<number>((resolve) => {
      server.once('exit', (code) => resolve(code ?? 0));
    });
    server.kill('SIGTERM');
    const exitCode = await shutdownPromise;
    assert.equal(exitCode, 0, 'Server should exit cleanly with code 0 on SIGTERM');
    assert.match(serverLogs, /server\.stopped/, 'Server should log server.stopped on graceful shutdown');
    console.info('✓ Graceful shutdown verified on SIGTERM with clean exit');

    console.info('\nAll Production Readiness checks PASSED successfully!');
  } finally {
    if (!server.killed) {
      server.kill('SIGKILL');
    }
  }
}

runTests().catch((err) => {
  console.error('Production readiness check failed:', err);
  process.exit(1);
});
