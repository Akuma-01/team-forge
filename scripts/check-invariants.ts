import { z } from 'zod';
import { readConfig } from '../apps/api/src/config.js';
import { createPool } from '../apps/api/src/db/pool.js';
import { checkInvariants } from '../apps/api/src/db/invariants.js';
import { logDatabaseError } from '../apps/api/src/db/errors.js';

const args = z.array(z.string().uuid()).max(1).safeParse(process.argv.slice(2));
if (!args.success) throw new Error('Usage: npm run invariants -- [hackathon-uuid]');
const pool = createPool(readConfig());
try {
  const checks = await checkInvariants(pool, args.data[0]);
  for (const check of checks) console.info(JSON.stringify(check));
  if (checks.some((check) => check.violations.length > 0)) process.exitCode = 1;
} catch (error) {
  logDatabaseError('invariants.failed', error);
  process.exitCode = 1;
} finally { await pool.end(); }
