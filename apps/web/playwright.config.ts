import { defineConfig, devices } from '@playwright/test';

/**
 * Browser E2E suite for the dashboard/admin/payment-page frontend (Phase 9).
 *
 * Unlike the rest of this repo's test suites, these drive a real running
 * stack end to end: apps/web talks to a real apps/api, which talks to a real
 * Postgres. There is no fake mode. Before running `pnpm test:e2e`:
 *   1. `pnpm dev:infra` (or `dev:pg:start`) - Postgres (+ Redis)
 *   2. `pnpm db:migrate:deploy`
 *   3. `pnpm seed` - creates the fixed dev credentials these tests log in with
 *   4. `pnpm dev:api` - apps/api on API_PORT (default 4000)
 * Playwright builds apps/web and runs it with `next start` rather than
 * `next dev`: a fresh Turbopack dev server compiles each route lazily on
 * first request, which under this suite's parallel load pushed several
 * first-ever navigations past their timeout. A production build removes
 * that on-demand compile step entirely. Set PLAYWRIGHT_BASE_URL to point at
 * an already-running instance instead (skips the build).
 *
 * `globalSetup` logs in once per role and saves the session cookie
 * (storageState) for every other spec to reuse - see the comment there for
 * why (in short: `/v1/auth/login` is IP-rate-limited, and every worker here
 * shares one IP).
 */

const PORT = 3000;
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? `http://localhost:${PORT}`;

export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 1,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  timeout: 30_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: process.env.PLAYWRIGHT_BASE_URL
    ? undefined
    : {
        command: 'pnpm exec next build && pnpm exec next start --port ' + PORT,
        url: baseURL,
        reuseExistingServer: !process.env.CI,
        timeout: 300_000,
        stdout: 'pipe',
      },
});
