# ADR 0015 - Cross-package integration tests run against real Postgres and a real loopback HTTP server, never a mocked transport or database

Status: Accepted
Date: 2026-09-10

## Context

Phase 9 (README roadmap) calls for integration testing distinct from the
per-package unit suites and from `apps/api`'s existing `*.e2e.test.ts` suite
(which already boots the real Nest app against real Postgres + Redis). The
gap was specifically *cross-package* integration: proving that packages
compose correctly when wired together the way the real apps wire them,
without any layer of the path under test being mocked.

Two existing suites came close but stopped short:

* `apps/blockchain-monitor/test/monitor.e2e.test.ts` already drives
  `MonitorService` against real Postgres and `FakeBlockchainAdapter` (a real,
  minimal `BlockchainAdapter` implementation per ADR 0004, not a mock) through
  to a `webhook_events` row - but never proves that row is actually
  deliverable. Dispatch is `apps/worker`'s job, which `MonitorService` never
  touches.
* `packages/webhooks/test/dispatcher.test.ts` proves `WebhookDispatcher`'s
  state machine against real Postgres, but its `fetchImpl` is `vi.fn()` for
  every case - the one thing never exercised for real is the actual HTTP
  delivery a merchant's server would receive.

## Decision

Two new suites close this gap, and both run a real receiver instead of
mocking the transport:

1. **`packages/webhooks/test/dispatcher.live-http.test.ts`** - a real
   `node:http` server on loopback stands in for the merchant endpoint.
   `WebhookDispatcher` makes a genuine HTTP call to it (success, a real
   failed-then-retried attempt, and a real `AbortSignal` timeout), and the
   receiver verifies the signature itself with `verifyWebhookSignature`
   exactly as a real integration would.
2. **`apps/blockchain-monitor/test/full-pipeline.e2e.test.ts`** - the full
   chain in one test: a simulated on-chain payment through `MonitorService`
   (detection, confirmation, ledger posting) to `@gateway/webhooks`'s real
   `WebhookDispatcher` delivering to the same kind of real local receiver.
   `@gateway/webhooks` and `@gateway/security` are added as
   **devDependencies only** - `apps/blockchain-monitor` still never dispatches
   webhooks in production; only its test suite now proves the two apps'
   halves fit together.

Both require `blockPrivateNetworks: false` on the dispatcher, because
`assertPublicWebhookUrl` (ssrf-guard.ts) refuses loopback/private addresses
unconditionally and by design - that check runs before any resolver hook
could redirect it, so there is no way to reach `127.0.0.1` with the guard on.
Turning it off for a real local receiver is correct for a test; it would not
be for a merchant-supplied URL in production.

With the guard off, nothing stops the dispatcher's global `runOnce()` from
also picking up an unrelated leftover row from the same shared dev database
(e.g. `dispatcher.test.ts`'s `https://merchant.example.com/webhooks` fixture,
whose retry timer is computed off a frozen test clock and can look "due"
again by real wall-clock time). Both new suites pass a `guardedFetch` wrapper
as `fetchImpl` instead of the bare global `fetch`: it performs a real request,
but only to that test's own receiver URL, and throws for anything else. This
is not a mock of the behaviour under test - the one URL that matters still
gets a genuine network round trip - it only prevents an unrelated stale
fixture from producing a real outbound request to a third-party host.

`pnpm test:integration` now runs `@gateway/database`, `@gateway/webhooks`,
and `@gateway/blockchain-monitor` - the suites that specifically exercise
real infra across package boundaries - as a faster, narrower check than the
full `pnpm test` run.

## Consequences

* Redis-backed integration (rate limiting, idempotency) already has real-infra
  coverage in `apps/api/test/rate-limit.e2e.test.ts` and is unaffected by this
  ADR; it is not duplicated here.
* Not covered by any suite yet: dedicated security testing (fuzzing,
  authz-boundary probing beyond what the e2e suites incidentally check) and
  load testing - both remain open Phase 9 line items.
* The SSRF guard's own TOCTOU limitation (documented in `ssrf-guard.ts`) is
  unrelated to and unaffected by this decision - these tests bypass the guard
  entirely rather than exercising its resolve-then-connect race.
