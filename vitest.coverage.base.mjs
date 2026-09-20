// Shared Vitest coverage settings, imported by every project's vitest.config.ts
// the same way eslint.config.base.mjs is shared for lint (see that file's
// header comment for why a per-project import is required in a pnpm
// workspace rather than one root config). v8 is Node's native coverage
// instrumentation (no source-map babel step, matches this project's `swc`/
// `tsc` toolchain) and is already the provider bundled with this project's
// pinned `vitest@^3.0.5` (`@vitest/coverage-v8@^3.0.5`).
export const coverage = {
  provider: 'v8',
  // Instrumentation only runs when a script invokes `vitest run --coverage`
  // (e.g. `test:coverage`) - the plain `test`/`test:unit` scripts are
  // unaffected, so coverage never slows down or changes the everyday
  // `pnpm test` developers and CI's `test` job already run.
  reporter: ['text', 'json-summary', 'lcov'],
  reportsDirectory: './coverage',
  include: ['src/**/*.ts'],
  exclude: [
    'src/**/*.d.ts',
    'src/**/*.test.ts',
    'src/**/main.ts', // process entrypoints - exercised by e2e/integration runs, not unit coverage
  ],
};
