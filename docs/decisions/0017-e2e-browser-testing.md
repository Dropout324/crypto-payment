# ADR 0017 - E2E browser testing for `apps/web`, a production build over `next dev`, and one real bug it caught

Status: Accepted
Date: 2026-09-10

## Context

Phase 9 (README roadmap) calls for unit, integration, E2E, security, and load
testing. Every other item had test coverage of some kind already; `apps/web`
(the Next.js dashboard/admin/payment-page frontend, Phase 7) had none - no
test directory, no browser-testing dependency anywhere in the repo. Its
existing `*.e2e.test.ts` suites elsewhere in the monorepo (`apps/api`) are
in-process Nest + supertest tests: real, but they never render anything or
touch a browser, so nothing had ever exercised session-cookie gating,
role-based redirects, or actual page content as a browser sees them.

## Decisions

### Playwright, driving a real `next build && next start`, not `next dev`

`@playwright/test` is the only browser-automation dependency added
(`apps/web/playwright.config.ts`, tests in `apps/web/e2e/`). It talks to a
real running stack - real `apps/api`, real Postgres - the same "no fake mode"
posture as the rest of Phase 9's integration/load suites; there is no mocked
transport to fall back to.

The config initially ran the suite against `next dev` (Turbopack). Under this
suite's parallel load, several first-ever navigations to a route timed out
waiting on Turbopack's on-demand compile of that route - a shared single
dev-server instance serializes those compiles, so concurrent workers hitting
different routes for the first time contend with each other. Switching the
`webServer` command to `next build && next start` (a real production build,
no on-demand compilation step) made that class of flake disappear entirely
across repeated runs, at the cost of a build step (roughly a minute) before
the first test. `PLAYWRIGHT_BASE_URL` still lets a contributor point the
suite at an already-running instance (dev or prod) and skip the build.

### `globalSetup` logs in once per role; every other spec reuses that session via `storageState`

`/v1/auth/login` is rate-limited to `RATE_LIMIT_AUTH_PER_MINUTE` (10,
IP-keyed - ADR 0011), which exists specifically to blunt credential-stuffing
since there is no caller identity yet at that point. Every Playwright worker
on one machine shares the same loopback IP, so a first version of this suite
that logged in through the UI in every test's `beforeEach` reliably tripped
that limiter under `fullyParallel` execution - tests failed on login itself,
not on anything they were meant to check. `e2e/global-setup.ts` now logs in
once per role directly against the API and saves the session cookie
(`e2e/.auth/{merchant,admin}.json`); `merchant-dashboard.spec.ts`,
most of `admin.spec.ts`, and the invoice-fixture half of `public-pay.spec.ts`
start each test with `test.use({ storageState })` instead of a fresh login.
`auth.spec.ts` is the deliberate exception - it exists specifically to test
the login form itself, so it logs in for real, same as the one
login-redirect assertion kept in `admin.spec.ts`. Total real logins per
full run: five, comfortably under the limit even with all workers racing.

### Invoice-creation fixtures go through the public API, not a DB seed

`public-pay.spec.ts`'s "renders a real invoice" test needs a payable invoice
to exist. Rather than reach into Postgres directly (which would need
`apps/web`'s test code to depend on `@gateway/database` and duplicate
domain knowledge it doesn't otherwise need), `e2e/support/invoice.ts` uses
the authenticated `page.request` context to do exactly what a real
integration would: create an API key (`POST /v1/merchant/me/api-keys`),
register a fresh deposit address (`POST /v1/merchant/addresses` - fresh
per run, since a pool address is single-use, see
`apps/api/src/invoices/invoices.service.ts`), and create the invoice
(`POST /v1/payment-invoices`). This exercises real endpoints as a test
side effect and needs no direct database access. It does mean this one test
needs a reachable exchange-rate provider (ADR 0005 - no fake mode outside
unit tests); it wraps fixture creation in `test.skip()` on failure rather
than failing outright, matching this repo's existing posture toward
external network dependencies (e.g. `rpc-adapter.live.test.ts`'s
`describe.skipIf`).

### A real bug this suite caught: `apps/web`'s error parser read the wrong field

Writing the "wrong password" test surfaced a genuine bug, not a test
mistake: `apps/web/src/lib/api.ts`'s `apiRequest` parsed a failed
response's body as `{ message, code }` at the top level, but
`apps/api`'s actual error envelope (`AppExceptionFilter`,
`apps/api/src/common/http-exception.filter.ts`) nests both fields under
`error`: `{ error: { code, message, ... } }`. Every API error shown
anywhere in the dashboard was therefore falling back to a generic HTTP
status string (`res.statusText`, e.g. "Unauthorized") instead of the
server's actual message (e.g. "invalid email or password") - silently,
since nothing before this suite ever asserted on error text. Fixed by
reading `body.error?.message` / `body.error?.code` instead.

## Consequences

* `pnpm test:e2e:web` (root) / `pnpm test:e2e` (`apps/web`) runs the full
  suite: login/session gating, every merchant-dashboard and admin page
  (read-only, matching Phase 7's current state), role-based route
  protection in both directions, and the public payment page's both states
  (unknown invoice, and a freshly created one). 20 tests, ~35s end to end
  once the production build is warm.
* Not run in CI yet - there is no CI pipeline in this repo at all (Phase 10).
  `forbidOnly`/`retries`/the `github` reporter are wired up for when one
  exists.
* Covers only what Phase 7 actually built: every dashboard/admin page is
  read-only, so there is nothing yet to test for create/rotate/revoke/
  approve/reject forms. Bitcoin has no adapter (ADR 0010's known gap), so
  nothing here exercises a Bitcoin payment address or invoice.
* This is the last item this pass adds to Phase 9. Security testing
  (ADR 0016) and load testing (see the load-testing ADR) each already
  identified their own follow-up work; nothing here changes those.
