import { z } from 'zod';

const databaseUrl = z.string().url().refine(
  (value) => ['postgres:', 'postgresql:'].includes(URL.parse(value)?.protocol ?? ''),
  'Expected a PostgreSQL connection URL',
);

const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().min(1).default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  APP_ORIGIN: z.string().url().default('http://localhost:5173'),
  DATABASE_URL: databaseUrl,
  DATABASE_URL_DIRECT: databaseUrl.optional(),
  PG_POOL_MAX: z.coerce.number().int().min(1).max(100).default(20),
}).superRefine((config, ctx) => {
  const origin = URL.parse(config.APP_ORIGIN);
  if (!origin) return;
  if (origin.origin !== config.APP_ORIGIN || !['http:', 'https:'].includes(origin.protocol)) {
    ctx.addIssue({ code: 'custom', path: ['APP_ORIGIN'], message: 'Use an HTTP(S) origin without a path or trailing slash' });
  }
  if (config.NODE_ENV === 'production' && origin.protocol !== 'https:') {
    ctx.addIssue({ code: 'custom', path: ['APP_ORIGIN'], message: 'Production requires HTTPS' });
  }
});

export type Config = z.infer<typeof configSchema>;

export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = configSchema.safeParse(env);
  if (!result.success) {
    // Report field names only: environment values may contain credentials.
    const fields = [...new Set(result.error.issues.map((issue) => issue.path.join('.')))];
    throw new Error(`Invalid configuration: ${fields.join(', ')}`);
  }
  return result.data;
}
