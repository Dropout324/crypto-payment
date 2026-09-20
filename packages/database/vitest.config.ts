import { defineConfig } from 'vitest/config';
import { coverage } from '../../vitest.coverage.base.mjs';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // Points createPrismaClient()'s implicit DATABASE_URL read at
    // TEST_DATABASE_URL instead - see ADR 0020 and scripts/test/test-database.mjs.
    setupFiles: ['../../scripts/test/integration-env.ts'],
    // Integration tests share one database; run them serially.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage,
  },
});
