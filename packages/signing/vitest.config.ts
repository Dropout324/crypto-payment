import { defineConfig } from 'vitest/config';
import { coverage } from '../../vitest.coverage.base.mjs';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage,
  },
});
