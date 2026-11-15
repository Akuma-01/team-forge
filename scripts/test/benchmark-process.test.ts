import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { startServer } from '../benchmark-process.js';

it('rejects an unrelated ready server and cleans up a child that never starts', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'teamforge-process-review-'));
  const existing = createServer((_req, res) => res.end('ok'));
  existing.listen(0, '127.0.0.1'); await once(existing, 'listening');
  const port = (existing.address() as { port: number }).port;
  const entry = resolve(directory, 'hung.cjs'); const pidFile = resolve(directory, 'pid');
  await writeFile(entry, `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`);
  try {
    await expect(startServer({ port, entry, timeoutMs: 500 })).rejects.toThrow('startup timed out');
    expect((await fetch(`http://127.0.0.1:${port}/ready`)).status).toBe(200);
    const pid = Number(await readFile(pidFile, 'utf8'));
    expect(() => process.kill(pid, 0)).toThrow();
  } finally {
    await new Promise<void>((done) => { existing.close(() => done()); existing.closeAllConnections(); });
    await rm(directory, { recursive: true, force: true });
  }
});
