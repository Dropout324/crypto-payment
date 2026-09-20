# Load testing

Four `autocannon` scenarios against a real, running API instance (not the
in-process Nest testing module `apps/api/test` uses) - a load test that never
leaves the process is a load test of nothing. Each scenario targets one
authentication mode this API has, since that is what actually differentiates
their cost: no auth, Argon2-verified API key, Argon2-verified password, and a
stateless JWT.

| Scenario | Endpoint | Auth | Expected bottleneck |
|---|---|---|---|
| `public-invoice-polling` | `GET /v1/public/invoices/:id` | none | DB read + per-IP rate limit |
| `dashboard-read` | `GET /v1/merchant/me/balance` | JWT cookie | one indexed DB lookup (membership) |
| `invoice-creation` | `POST /v1/payment-invoices` | API key | Argon2id (light params) + `FOR UPDATE SKIP LOCKED` address reservation |
| `auth-login` | `POST /v1/auth/login` | password | Argon2id (OWASP params, heavier than the API key's) |

## Setup

1. Infra: `pnpm dev:infra` (or, if Postgres already runs outside Docker per
   `scripts/dev-postgres.ps1`, just `docker compose up -d redis`).
2. Start the API against real config: `pnpm dev:api`. Load testing against
   `NODE_ENV=test`'s effectively-unlimited rate limits (`apps/api/test/setup-env.ts`)
   would hide real 429 behaviour, so this deliberately runs the same
   `bootstrap.ts`/`.env` production code path uses, not the test app.
3. Seed fixture data (needs the API from step 2 already listening -
   `invoice-creation`'s poll-target invoices are created through the real
   endpoint): `pnpm loadtest:seed`. Writes `apps/api/loadtest/fixture.json`
   (gitignored - regenerate per run, never hand-edit).
4. Run a scenario: `pnpm loadtest -- <scenario> [--connections N] [--duration S]`,
   or `pnpm loadtest -- all` to run all four back to back. Full `autocannon`
   results land in `apps/api/loadtest/results/*.json` (gitignored).

## Two passes, because rate limiting is part of what's under test

Run each scenario twice:

- **Once against `.env` as checked in** (`RATE_LIMIT_AUTH_PER_MINUTE=10`,
  `RATE_LIMIT_API_PER_MINUTE=120`, `RATE_LIMIT_INVOICE_CREATE_PER_MINUTE=60`).
  Every `autocannon` connection shares one loopback IP/API-key/merchant
  identity, so this pass is expected to hit 429s almost immediately - that is
  the correct behaviour to confirm (`Retry-After` present, `4xx` count
  matching the configured ceiling), not a harness bug.
- **Once with the limits raised** (e.g. `RATE_LIMIT_API_PER_MINUTE=1000000`
  in a scratch `.env` override, then restart `pnpm dev:api`) to measure the
  endpoint's actual capacity once the rate limiter is no longer the
  constraint - the number that matters for capacity planning.

## Sizing

- `invoice-creation` permanently retires one seeded address per successful
  call (deposit addresses are never reused - SPEC section 8). A run's
  `connections × duration × (requests/sec)` must stay under
  `fixture.seededAddressCount` (`LOADTEST_ADDRESS_COUNT` env var to `pnpm
  loadtest:seed`, default 3000) or later requests start failing with 422
  `ADDRESS_POOL_EXHAUSTED` - re-seed to top the pool back up.
- `public-invoice-polling` cycles through a fixed pool of
  `LOADTEST_POLL_INVOICE_COUNT` invoices (default 200) created via the real
  endpoint during seeding, so read load never touches the address pool.

## Known constraints, not bugs

- The database seen here is the same one `apps/api/test`'s e2e suite and
  `pnpm dev:api` use - this measures single-instance capacity on whatever
  hardware runs it, not a production topology (connection pooling,
  read replicas, multiple API instances behind a load balancer are all
  out of scope for this harness).
- `invoice-creation`'s exchange-rate lookup goes through the real
  `ExchangeRateService` (coingecko/binance), not the fixed-rate fake
  `apps/api/test/support/create-test-app.ts` uses for e2e tests - the first
  request for a given asset/currency pair pays real network latency, then
  `EXCHANGE_RATE_CACHE_TTL_SECONDS` (default 30s) serves the rest from cache,
  so this is a one-time warm-up cost, not a steady-state one.
