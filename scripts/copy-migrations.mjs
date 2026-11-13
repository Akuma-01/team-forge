import { cp } from 'node:fs/promises';

await cp(new URL('../apps/api/src/db/migrations/', import.meta.url),
  new URL('../apps/api/dist/db/migrations/', import.meta.url), { recursive: true });
