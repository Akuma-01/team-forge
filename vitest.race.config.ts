import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node', include: ['apps/api/test/race/**/*.test.ts'],
    // Requests inside a case are concurrent. Run files serially so independent
    // races do not compete for database capacity or obscure the required pool-20 run.
    fileParallelism: false, testTimeout: 20_000, hookTimeout: 20_000,
  },
});
