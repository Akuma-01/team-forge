import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { apiErrorSchema, healthSchema } from '@teamforge/shared';
import { createApp } from '../src/app.js';

const servers: Server[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  })));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function start(options: Partial<Parameters<typeof createApp>[0]> = {}) {
  const app = createApp({
    checkDatabase: async () => { throw new Error('Database must not be accessed by this test.'); },
    ...options,
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  servers.push(server);
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

describe('foundation HTTP boundaries', () => {
  it('serves liveness without a database and supplies a request ID', async () => {
    const base = await start();
    const response = await fetch(`${base}/health`);
    expect(response.status).toBe(200);
    expect(healthSchema.parse(await response.json())).toEqual({ status: 'ok' });
    expect(response.headers.get('x-request-id')).toMatch(/^[a-f0-9-]{36}$/);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-powered-by')).toBeNull();
  });

  it('reports unavailable readiness without exposing database errors', async () => {
    const base = await start({ checkDatabase: async () => { throw new Error('private-database-address'); } });
    const response = await fetch(`${base}/ready`);
    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('1');
    const body = apiErrorSchema.parse(await response.json());
    expect(body.error.code).toBe('BUSY');
    expect(JSON.stringify(body)).not.toContain('private-database-address');
    expect(body.error.requestId).toBe(response.headers.get('x-request-id'));
  });

  it('rejects malformed JSON with the shared error envelope', async () => {
    const base = await start();
    const response = await fetch(`${base}/api/missing`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad',
    });
    expect(response.status).toBe(400);
    expect(apiErrorSchema.parse(await response.json()).error.code).toBe('VALIDATION_ERROR');
  });

  it('enforces the 10 kB request limit', async () => {
    const base = await start();
    const response = await fetch(`${base}/api/missing`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'x'.repeat(11_000) }),
    });
    expect(response.status).toBe(413);
    expect(apiErrorSchema.parse(await response.json()).error.code).toBe('VALIDATION_ERROR');
  });

  it('serves SPA navigation but keeps API, operational and missing asset routes out of the fallback', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'teamforge-shell-'));
    directories.push(directory);
    await writeFile(join(directory, 'index.html'), '<!doctype html><title>TeamForge</title>');
    const base = await start({ production: true, webDirectory: directory });
    const page = await fetch(`${base}/teams/example`, { headers: { Accept: 'text/html' } });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('<title>TeamForge</title>');
    expect(page.headers.get('strict-transport-security')).toContain('max-age=');
    for (const path of ['/api', '/api/missing', '/metrics', '/assets/missing.js', '/.env']) {
      const response = await fetch(`${base}${path}`, { headers: { Accept: 'text/html' } });
      expect(response.status, path).toBe(404);
      expect(apiErrorSchema.parse(await response.json()).error.code, path).toBe('NOT_FOUND');
    }
  });
});
