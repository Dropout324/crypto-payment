# ADR 0015 - Load testing: autocannon against a real running instance, four scenarios by auth mode, one concurrency bug found and fixed

Status: Accepted
Date: 2026-09-10

## Context

Phase 9 (README roadmap) calls for unit, integration, E2E, security, and
load testing. Unit/integration/E2E coverage already exists per-feature
(every phase 1-8 ADR added its own `*.test.ts`/`*.e2e.test.ts`), so this ADR
covers only the load-testing slice: `apps/api/loadtest/`, four `autocannon`
scenarios (`public-invoice-polling`, `dashboard-read`, `invoice-creation`,
`auth-login`), and what running them against a real local instance
(Postgres + Redis, `pnpm dev:api`) surfaced.

## Decisions

### `autocannon`, not k6/artillery, and against a real process, not the Nest testing module

`autocannon` is a pure-Node devDependency (`apps/api/package.json`) -
no external binary to install, which matters on a Windows dev machine
without a package manager for one. It is scriptable enough (`setupRequest`
per call) to generate unique `order_id`/`Idempotency-Key` values per request,
which `invoice-creation` needs.

Every scenario targets a real `pnpm dev:api` process, not
`apps/api/test/support/create-test-app.ts` (the in-process Nest testing
module the e2e suite uses). The e2e app swaps in a fixed-rate exchange
provider and, per `apps/api/test/setup-env.ts`, runs with rate limiting
effectively disabled - neither is representative of what a load test needs
to measure. A harness that never leaves the process cannot see connection
pool exhaustion, Redis round trips, or real rate-limit rejection.

### Four scenarios, one per authentication mode

Auth mode is what actually differentiates request cost here more than the
endpoint's own logic does:

| Scenario | Endpoint | Auth | Per-request cost |
|---|---|---|---|
| `public-invoice-polling` | `GET /v1/public/invoices/:id` | none | one indexed DB read |
| `dashboard-read` | `GET /v1/merchant/me/balance` | JWT cookie (`JwtAuthGuard`) | stateless HS256 verify + one `merchantMember` lookup |
| `invoice-creation` | `POST /v1/payment-invoices` | API key (`ApiKeyGuard`) | Argon2id (light params: 8 MiB, time cost 1) + `SELECT ... FOR UPDATE SKIP LOCKED` address reservation + DB writes |
| `auth-login` | `POST /v1/auth/login` | password | Argon2id (OWASP params: 19 MiB, time cost 2 - `packages/security/src/password.ts`) |

### Fixture data via `seed.ts`, reusing the e2e suite's own merchant helper

`apps/api/loadtest/seed.ts` calls `seedMerchantWithLogin` from
`apps/api/test/support/seed-merchant-login.ts` rather than duplicating
merchant/API-key/user provisioning - it is the same "isolated merchant"
every e2e test already relies on. It additionally bulk-inserts a
configurable pool of `AVAILABLE` payment addresses (`invoice-creation`
retires one per call - SPEC section 8: never reuse) and pre-signs a
dashboard JWT directly with `signJwt` rather than running a real login per
fixture regeneration (login has its own scenario; the fixture's token only
needs to authenticate `dashboard-read`).

## Findings

All numbers below are single-instance, single-machine (client and server
share one CPU), so they characterise relative cost between endpoints and
real defects, not an absolute production capacity figure - see
"Known constraints" in `apps/api/loadtest/README.md`.

### Rate limiting (ADR 0011) works exactly as specified under real load

Run against `.env` as checked in, `public-invoice-polling` returned exactly
120 `2xx` (matching `RATE_LIMIT_API_PER_MINUTE=120`) before every subsequent
request in the window got `429` with a `Retry-After` header; `auth-login`
and `invoice-creation` showed the same pattern against their own
(`RATE_LIMIT_AUTH_PER_MINUTE=10`, `RATE_LIMIT_INVOICE_CREATE_PER_MINUTE=60`)
ceilings. No further action needed here - this is confirmation, not a
finding.

### Read paths are fine; Argon2-guarded writes are the bottleneck, as expected

Warm, elevated-limit numbers (client and server on one machine):

| Scenario | req/s | p50 | p99 | errors |
|---|---|---|---|---|
| `dashboard-read` | 169.9 | 166ms | 424ms | 0 |
| `public-invoice-polling` | 107.4 | 262ms | 904ms | 0 |
| `invoice-creation` | 50.5-66.0 | 359-700ms | 1077-1195ms | 0% (post-fix, see below) |
| `auth-login` | 55.2-57.2 | 347-827ms | 623-1622ms | 0% (post-fix) |

`auth-login` costing noticeably more than `invoice-creation` matches the
Argon2 parameters directly: 19 MiB/time-cost-2 (password) versus 8 MiB/time-
cost-1 (API key) - see `packages/security/src/password.ts` and
`api-key.ts`. Neither read scenario touches Argon2 at all, and both stayed
in double-digit-millisecond-to-low-hundreds territory with zero errors at
30 concurrent connections.

### A real bug: concurrent writers against one hot row exhaust the transaction retry budget

`invoice-creation` (many concurrent invoices for **one** merchant, so every
transaction reads the same address-pool predicate) and `auth-login` (many
concurrent logins for **one** user, so every transaction writes the same
`User` row) both produced a wave of `500`s under load:

```
PrismaClientKnownRequestError: Transaction failed due to a write conflict
or a deadlock. Please retry your transaction
```

`runInTransaction` (`packages/database/src/client.ts`) already retries
exactly this class of error (Postgres `40001`/`40P01`, Prisma `P2034`) with
jittered backoff - by design, every money-touching transaction in this
codebase runs at `Serializable` isolation specifically so read-modify-write
races become retryable errors instead of silent corruption. The retry
budget just was not big enough: at `maxRetries: 3` (the old default), 20
concurrent `auth-login` connections against one user produced a 44.9%
error rate, and 20 concurrent `invoice-creation` connections against one
merchant's address pool produced 65.4%. Every one of this codebase's ~20
`runInTransaction` call sites (`auth.service.ts`, `invoices.service.ts`,
`members.service.ts`, `admin-*.service.ts`, `webhook-endpoints.service.ts`,
...) shared that same default, so this was not a single-endpoint bug.

**First attempt - raise the retry budget - was only a partial mitigation.**
`packages/database/src/client.ts`'s default `maxRetries` raised from 3 to 8
cut the error rate roughly in half (`auth-login` 44.9%→25.4%,
`invoice-creation` 65.4%→16.9% at 15-20 connections) but did not eliminate
it, and it had a real cost: `auth-login`'s p50 latency went from 1447ms to
4165ms, and 9 of 40 requests in that run timed out client-side (10s)
instead of failing fast - conflicting transactions now queued for longer
rather than being rejected quickly. This part of the change is kept (see
Consequences) because it is a strictly-safer default for the ~18 other
`runInTransaction` call sites that stay at `Serializable` for a real
reason, but it was never going to fully solve this.

**Second attempt - an advisory lock around the contended section - looked
right and was not.** The natural next move was wrapping each hot
transaction in `withAdvisoryLock` (`packages/database/src/client.ts`,
already used elsewhere in this codebase), keyed per merchant for
`invoice-creation` and per user for `auth-login`, so concurrent writers
would queue through Postgres's lock manager instead of racing through
`Serializable`'s conflict detector. Re-running the load test after wiring
this up still produced `40001 could not serialize access due to concurrent
update` errors - unchanged from before the lock. The reason: `pg_advisory_xact_lock`
is a normal statement, and a `Serializable` transaction's snapshot is fixed
at its *first* statement - which, inside `withAdvisoryLock`, is the lock
call itself, before the wait for the lock resolves. A transaction that
waited behind another proceeds afterward still holding a snapshot taken
*before* the lock-holder's commit, so its reads are stale relative to what
just committed, and Postgres flags that as a conflict regardless of the
fact that the two transactions never actually ran concurrently in wall-clock
time. An advisory lock serialises *when* a transaction is allowed to
proceed; it does not - and cannot - move a `Serializable` snapshot forward.
This is now reverted out of both call sites; it added latency (every
invoice creation for one merchant queued behind every other) for no
reduction in errors.

**The actual fix: run these two transactions at Read Committed, not
Serializable.** Neither transaction has a multi-row invariant that needs
`Serializable`'s protection - the one thing that has to be correct
(`invoice-creation` never assigning the same deposit address twice) is
already guaranteed by `FOR UPDATE SKIP LOCKED`'s real row lock, which holds
at any isolation level; `auth-login`'s transaction is an unconditional
overwrite of the caller's own user row plus a fresh session insert, nothing
conditional on a stale read. Under Read Committed, a Postgres `UPDATE`
blocks behind a concurrent writer on the same row, then re-reads and
re-applies once that writer commits - it never aborts with `40001`, because
Read Committed re-takes its snapshot per-statement rather than fixing it
for the whole transaction. `apps/api/src/invoices/invoices.service.ts`
(`createInvoice`) and `apps/api/src/auth/auth.service.ts` (`login`) now pass
`{ isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted }` to
their `runInTransaction` call - every other call site in the codebase is
untouched and stays at the `Serializable` default.

Re-running the exact same load (20 concurrent connections, one merchant / one
user) after this fix:

| Scenario | error rate before any fix | after `maxRetries` bump only | after Read Committed |
|---|---|---|---|
| `auth-login` | 44.9% | 25.4% | **0%** |
| `invoice-creation` | 65.4% | 16.9% | **0%** |

Throughput and latency improved alongside the error rate, since requests
stopped queuing through retries entirely: `auth-login` went from 2.4 req/s
(p50 4165ms, with 9/40 requests hitting the client's 10s timeout) to 55.2
req/s (p50 347ms, zero errors); `invoice-creation` went from 7.3 req/s (p50
882ms) to 50.5 req/s (p50 359ms). Both held at 0% errors re-run at 50
concurrent connections too (`auth-login` 57.2 req/s p50 827ms;
`invoice-creation` 66.0 req/s p50 700ms) - the remaining latency at that
concurrency is Argon2 CPU cost queuing on this one-CPU dev machine, not
transaction contention.

**Not covered by this pass, left for a follow-up decision:** mapping
retry-exhausted errors on the *other* `Serializable` call sites to a
distinct, retryable HTTP response (e.g. `503` with `Retry-After`, matching
the rate-limiter's existing posture) instead of `AppExceptionFilter`'s
generic unhandled `500` - those call sites (ledger postings, refunds,
settlements, admin actions) do have genuine multi-row invariants and
correctly stay at `Serializable`, so they can still hit `40001` under
enough contention; a client currently cannot tell "transient, retry me"
from "broken" for those. Also missing: no unit/integration test exercises
`runInTransaction`'s retry path or isolation-level override at all
(`packages/database/test/` has none) - this class of bug had no test that
would have caught it before a load test did.

## Consequences

* `apps/api/loadtest/` (seed script, four scenarios, CLI runner) is
  reusable for any future capacity or regression check - `pnpm
  loadtest:seed` then `pnpm loadtest -- <scenario|all>`.
* `packages/database/src/client.ts`'s `runInTransaction` default
  `maxRetries` is now 8 (was 3), affecting every transactional write in the
  codebase that stays at `Serializable` (i.e. everywhere except the two call
  sites below). This is a strictly-more-resilient parameter change (retries
  are already proven safe/idempotent-safe by the existing mechanism), not a
  semantic one.
* `invoices.service.ts`'s `createInvoice` and `auth.service.ts`'s `login`
  now run their transactions at Read Committed instead of the codebase
  default `Serializable`, verified safe because neither has a multi-row
  invariant depending on the stricter level (see Findings). This is a
  targeted, per-call-site change - `runInTransaction`'s default stays
  `Serializable` for every other call site.
* Confirmed by re-running the load test at both 20 and 50 concurrent
  connections against one merchant/one user: 0% errors, ~7-23x higher
  throughput, and roughly 5x lower p50 latency than either the unfixed
  baseline or the retry-budget-only mitigation.
* README roadmap's Phase 9 row now credits load testing as done, with unit/
  integration/E2E credited to the coverage already built phase-by-phase and
  security testing flagged as the still-open item.
* Not covered by this pass: the distinct-retryable-HTTP-status follow-up
  above for the `Serializable` call sites that remain, a test for
  `runInTransaction`'s retry/isolation-override behaviour, and anything
  beyond single-instance capacity (connection pooling, read replicas,
  multi-instance behind a load balancer - see "Known constraints" in
  `apps/api/loadtest/README.md`).
