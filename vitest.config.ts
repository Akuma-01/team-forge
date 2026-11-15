import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['apps/api/test/**/*.test.ts', 'apps/web/src/**/*.test.ts', 'packages/shared/test/**/*.test.ts', 'scripts/test/**/*.test.ts'],
    exclude: ['apps/api/test/race/**'],
    maxWorkers: 2,
    testTimeout: 10_000,
    hookTimeout: 10_000,
  },
});
