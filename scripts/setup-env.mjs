import { randomBytes } from 'node:crypto';
import { readFile, writeFile, chmod } from 'node:fs/promises';

let source;
try { source = await readFile('.env', 'utf8'); } catch (error) {
  if (error.code !== 'ENOENT') throw error;
  source = await readFile('.env.example', 'utf8');
}
const secretLine = source.match(/^JWT_SECRET=(.*)$/m);
if (!secretLine || !secretLine[1].trim() || secretLine[1].startsWith('replace-')) {
  const line = `JWT_SECRET=${randomBytes(32).toString('hex')}`;
  source = secretLine ? source.replace(/^JWT_SECRET=.*$/m, line) : `${source}\n${line}\n`;
}
await writeFile('.env', source, { mode: 0o600 });
await chmod('.env', 0o600);
console.info('Local .env prepared. Existing configuration and non-placeholder secrets were preserved.');
