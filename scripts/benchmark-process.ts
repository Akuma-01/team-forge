import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';

export const projectRoot = resolve(import.meta.dirname, '..');
export function k6Command() {
  return process.env.K6_BIN || (existsSync(resolve(projectRoot, 'loadtest/bin/k6')) ? resolve(projectRoot, 'loadtest/bin/k6') : 'k6');
}

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((done, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', done); });
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((done, reject) => probe.close((error) => error ? reject(error) : done()));
  return port;
}

export async function stopServer(server: ChildProcess): Promise<void> {
  if (server.exitCode !== null || server.signalCode !== null) return;
  await new Promise<void>((done) => {
    const deadline = setTimeout(() => { server.kill('SIGKILL'); }, 3000);
    server.once('exit', () => { clearTimeout(deadline); done(); });
    server.kill('SIGTERM');
  });
}

// Readiness is accepted only after THIS child reports a successful bind. An
// unrelated process already listening on the requested port cannot pass it.
export async function startServer(options: { port?: number; entry?: string; timeoutMs?: number } = {}) {
  const port = options.port ?? await freePort();
  const timeoutMs = options.timeoutMs ?? 15_000;
  const server = spawn(process.execPath, ['--env-file-if-exists=.env', options.entry ?? 'apps/api/dist/server.js'], {
    cwd: projectRoot, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port) },
  });
  // Attach immediately, including for failures before startup listeners run.
  let spawnError: Error | undefined;
  server.on('error', (error) => { spawnError = error; });
  try {
    await new Promise<void>((done, reject) => {
      let pending = '';
      const deadline = setTimeout(() => finish(new Error('Benchmark server startup timed out.')), timeoutMs);
      const onExit = () => finish(new Error('Benchmark server exited before it started.'));
      const onError = () => finish(new Error('Benchmark server could not be started.'));
      const onData = (chunk: Buffer) => {
        pending += chunk.toString();
        const lines = pending.split('\n'); pending = lines.pop() ?? '';
        for (const line of lines) {
          try {
            const event = JSON.parse(line) as { event?: string; port?: number };
            if (event.event === 'server.started' && event.port === port) finish();
          } catch { /* non-JSON startup output */ }
        }
      };
      const finish = (error?: Error) => {
        clearTimeout(deadline); server.off('exit', onExit); server.off('error', onError); server.stdout?.off('data', onData);
        if (error) reject(error); else done();
      };
      server.once('exit', onExit); server.once('error', onError); server.stdout?.on('data', onData);
      server.stderr?.resume();
    });
    server.stdout?.resume();
    const started = performance.now();
    while (performance.now() - started < timeoutMs) {
      if (spawnError || server.exitCode !== null || server.signalCode !== null) throw new Error('Benchmark server exited before readiness.');
      try {
        const response = await fetch(`http://127.0.0.1:${port}/ready`, { signal: AbortSignal.timeout(1000) });
        await response.arrayBuffer();
        if (response.status === 200) return { server, port };
      } catch { /* retry within a monotonic deadline */ }
      await new Promise((done) => setTimeout(done, 100));
    }
    throw new Error('Benchmark server readiness timed out.');
  } catch (error) {
    if (server.pid) await stopServer(server);
    throw error;
  }
}

export function requireK6Success(code: number) {
  if (code !== 0) throw new Error(`k6 failed with exit code ${code}; performance gate did not pass.`);
}
