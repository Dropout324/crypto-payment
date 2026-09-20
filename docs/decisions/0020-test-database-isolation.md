# ADR 0020 - Test database isolation: `TEST_DATABASE_URL` resolved by a shared Vitest setup file, `apps/api` deliberately excluded

Status: Accepted
Date: 2026-09-11

## Context

A Phase 9.5 audit of the existing test setup found four compounding
problems, the last two of which had already caused real damage:

1. `pnpm test` (the root script, chaining `pnpm --filter <pkg> test` for
   every package) could not run green from a clean shell. Without `.env`
   loaded, `@gateway/database`'s `createPrismaClient()` throws immediately
   (`DATABASE_URL is not set`). With `.env` loaded (the only way anyone had
   actually been running the suite), `apps/api`'s own suite failed 34 tests,
   because `apps/api/test/setup-env.ts` used `??=` - a real `.env`'s
   `RATE_LIMIT_*` values (small, production-shaped) won against the test
   file's intentionally-huge defaults the moment `.env` was in scope, and
   every e2e file shares one real Redis and one loopback IP (ADR 0011),
   so unrelated tests started tripping each other's 429s.
2. `TEST_DATABASE_URL` was defined in `.env`/`.env.example`/the README and
   read by nothing. `createPrismaClient()` (`packages/database/src/client.ts`)
   falls back to `process.env.DATABASE_URL` when no explicit URL is passed,
   and every integration suite (`packages/database`, `packages/webhooks`,
   `packages/ledger`, `apps/worker`, `apps/blockchain-monitor`) calls it with
   no arguments. Every one of those suites was running against the
   development database, not `gateway_test`.
3. That was not a theoretical risk. `apps/worker`'s expiry-sweep suite failed
   3 of 6 tests because the dev database, polluted by earlier load-test runs
   (ADR 0015), had a large backlog of expired invoices; `sweepExpiredInvoices`
   fetched an arbitrary `batchSize`-sized subset of them (no `ORDER BY`) and
   the test's own fixtures sometimes lost that lottery. Fixed independently
   (see the `ORDER BY expires_at ASC` fix, which is also a real production
   correctness improvement, not just a test fix) - but the deeper problem is
   that a development database should never have been reachable from a test
   run at all.
4. `apps/api`'s own suite is intentionally the one exception: its
   `setup-env.ts` hardcodes `gateway_test` and every other test default,
   with no dependency on `.env` being loaded - by design (see below), not an
   oversight to fix the same way as the other five.

## Decisions

### `apps/api` stays hermetic and `.env`-independent; every other suite reads `.env` for itself

`apps/api/test/setup-env.ts` now assigns every value unconditionally (`=`,
not `??=`) - `NODE_ENV`, `DATABASE_URL`, both JWT secrets, `ENCRYPTION_KEY`,
`REDIS_URL`, and the three `RATE_LIMIT_*_PER_MINUTE` overrides. This suite
must produce the same result whether the invoking shell has `.env` loaded or
not, because it is the one suite where a real config value (a production
rate limit) silently winning is a documented way for unrelated tests to fail
(problem 1 above) - not a hypothetical.

Every other database-touching suite takes the opposite approach:
`scripts/test/integration-env.ts`, wired into each project's `vitest.config.ts`
via `setupFiles`, calls `process.loadEnvFile('.env')` if the file exists
(`scripts/test/test-database.mjs#loadLocalEnv`) - `loadEnvFile` never
overrides a variable the environment already set, so CI (which sets
`TEST_DATABASE_URL` directly, no `.env` file at all) and local development
(which has one) both work through the same code path - then overwrites
`DATABASE_URL` with the resolved `TEST_DATABASE_URL` before any test file's
own imports run. `apps/api` was deliberately left out of this shared
mechanism rather than folded into it, because its hazard (config bleeding
in from a real `.env`) is the opposite of the other five's (config never
reaching them without one).

### `TEST_DATABASE_URL` is required, with no fallback to `DATABASE_URL`

`resolveTestDatabaseUrl()` throws a specific, explanatory error rather than
falling back to `DATABASE_URL` when `TEST_DATABASE_URL` is unset - the
silent fallback is exactly problem 2. It also parses the resolved URL's
database name and refuses to proceed unless it contains "test"
(case-insensitive). This is a crude check - it does not prove the database
is actually disposable - but it turns "someone points `TEST_DATABASE_URL` at
`gateway` by copy-paste mistake" from silent data damage (these suites
insert, back-date and delete rows freely) into an immediate, named failure
at the first test file loaded, which is a trade worth making for one string
comparison.

### One resolver function, not five copies

`scripts/test/test-database.mjs` lives outside `apps/*`/`packages/*` (so it is
not itself a workspace project needing its own `package.json`/build step) and
is imported by both `scripts/test/integration-env.ts` (the Vitest setup file)
and `scripts/test/migrate-test-db.mjs` (`pnpm test:db:migrate`, which applies
Prisma migrations to `TEST_DATABASE_URL` - CI runs this once, before `pnpm
test`, against an empty database). Two entry points, one place that decides
what counts as a valid test database.

### Rejected: a Docker/Testcontainers-provisioned ephemeral database per run

Spinning up a fresh Postgres per test run (Testcontainers, or a
docker-compose service brought up only for CI) would remove the "which
database" question entirely by construction. Rejected for this pass because
it would diverge from `scripts/dev-postgres.ps1`'s existing no-Docker,
conda-based local Postgres (ADR 0003) - local and CI would then be running
against two different provisioning mechanisms for the same tests, which is
its own source of "passes in CI, fails locally" bugs. `TEST_DATABASE_URL`
pointed at a real, persistent `gateway_test` database matches what
`scripts/dev-postgres.ps1 init` already provisions today; revisiting this is
reasonable once Phase 10's CI/CD pipeline exists and has an opinion about
where that Postgres instance should live.

## Consequences

* `pnpm test` from a clean shell (no `.env`, no exported env vars) now fails
  fast with `resolveTestDatabaseUrl()`'s explanatory error for every suite
  except `apps/api` (which needs nothing external) - not a `DATABASE_URL is
  not set` from three modules deep, and not a silent run against whatever
  `DATABASE_URL` happens to be set to.
* `pnpm test:db:migrate` is the one new command CI needs before `pnpm test`:
  apply migrations to `TEST_DATABASE_URL`, then run the suite.
* The `ORDER BY expires_at ASC` fix to `sweepExpiredInvoices`
  (`apps/worker/src/expiry-sweep.ts`) is a genuine production behavior
  change, not only a test fix - see its own comment for why oldest-first
  matters outside of tests too.
* Not covered by this pass: per-test-file database isolation (transaction
  rollback per test, or a schema-per-worker scheme) - every suite here
  still shares one `gateway_test` database across all its own tests, using
  unique-suffixed fixtures (`RUN`/`suffix()` patterns already present in each
  suite) to avoid collisions between runs, which is unchanged by this ADR.
