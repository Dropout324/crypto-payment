import { defineConfig } from 'vitest/config';
import { coverage } from '../../vitest.coverage.base.mjs';

export default defineConfig({
  test: { environment: 'node', include: ['test/**/*.test.ts'], testTimeout: 20_000, coverage },
});
