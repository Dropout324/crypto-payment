# ADR 0009 - Webhook delivery: insert-per-attempt, no transaction around the network call, and a fail-open SSRF guard

Status: Accepted
Date: 2026-09-09

## Context

Phase 6 (SPEC sections 17, 18) needed a dispatcher that turns `webhook_events`
rows (already written by the API and the monitor) into HTTP deliveries against
merchant-controlled `webhook_endpoints`, with retries and replay-safe HMAC
signing (`@gateway/security`'s `signWebhook` already existed). Three design
questions came up that are easy to get wrong in a financial system:

1. How is a retry represented, given the schema comment "one row per attempt -
   retrying is an insert, never an overwrite" and `@@unique([webhookEventId,
   endpointId, attempt])`?
2. Can the HTTP call happen inside the same database transaction as the
   bookkeeping around it?
3. A `WebhookEndpoint.url` is merchant-supplied - effectively untrusted input
   from the gateway's point of view. How far does the SSRF guard go?

## Decisions

### Retries are new rows; only the newest row is ever "current"

Each attempt is its own `webhook_deliveries` row. A failed attempt with
budget left is marked `FAILED` and carries `next_retry_at`; when that becomes
due, the dispatcher inserts a NEW row for `attempt + 1` rather than mutating
the old one. The old `FAILED` row is left alone as permanent history of
exactly what happened on that attempt (status code, response body, timing).

Two rows are the only true terminal states with no further row to expect:
`DELIVERED` (success) and `EXHAUSTED` (attempt budget used up) or `ABANDONED`
(the endpoint disabled before or during this attempt - see below).

### The HTTP call is never inside a database transaction

`WebhookEndpoint.timeout_ms` is merchant-configurable (default 10s, schema
default). Holding a Postgres transaction open for up to that long per
delivery - worse, per delivery multiplied by however many are in flight -
would tie up pool connections and, more importantly, any row locks the
transaction implicitly holds, for as long as an arbitrary third party's
server takes to respond or hang. Instead each attempt is bracketed by two
small, independent writes: an atomic `PENDING -> IN_FLIGHT` claim (a
conditional `UPDATE ... WHERE status = 'PENDING'`, so two workers racing on
the same row cannot both send it), then the network call outside any
transaction, then a final write to `DELIVERED` / `FAILED` / `EXHAUSTED`.

The cost of that choice is a crash window: a worker that dies between the two
writes leaves a row stuck `IN_FLIGHT` forever. `WebhookDispatcher.
recoverStaleInFlight` is the mitigation - a row `IN_FLIGHT` past
`staleInFlightMs` (default 5 minutes, comfortably longer than any reasonable
`timeout_ms`) is treated as a failed attempt and retried through the normal
budget/backoff path. This mirrors `chain_cursors`' leased-scan-position
pattern elsewhere in this codebase: prefer "detect and recover from a crash"
over "hold a lock so a crash can't happen," because the latter is what turns
a slow merchant endpoint into a gateway-wide outage.

### An endpoint auto-disables after too many consecutive failures, and abandons what's still queued

`consecutive_failures` increments on every failed attempt (any endpoint,
any event) and resets to zero on any success. Past
`WEBHOOK_DISABLE_AFTER_CONSECUTIVE_FAILURES` (default 50), the endpoint
disables itself (`enabled = false`, `disabled_at`, `disabled_reason`) and
every one of its still-`PENDING` deliveries is marked `ABANDONED` in the same
pass - there is no value in queuing more attempts against an endpoint that
just proved itself unreachable across many different events, and the
`WebhookDeliveryStatus` enum already reserves `ABANDONED` for exactly this
("endpoint disabled or merchant closed") as distinct from `EXHAUSTED`
("retry budget exhausted" on one specific chain). A delivery that fails its
OWN last attempt gets `EXHAUSTED`; a delivery that still had attempts left
but its endpoint got disabled gets `ABANDONED` - the row's terminal status
says which of the two happened.

### The SSRF guard resolves-then-checks; it does not pin the connection

`assertPublicWebhookUrl` (`packages/webhooks/src/ssrf-guard.ts`) rejects a
private, loopback, link-local (including the `169.254.169.254` cloud
metadata address), or unresolvable host before every delivery attempt. It
does NOT pin the resolved address for the `fetch` that follows - `fetch`
re-resolves DNS on its own, so a DNS answer that changes between the two
lookups (rebinding) could in principle slip through. Closing that fully needs
a custom connection hook that pins the address used for verification, which
is real complexity for a threat that still requires the attacker to control
DNS for the exact moment of delivery. The check as built stops the ordinary
case - a URL that is privately-addressed from the start, which is what an
absent-minded merchant config or a lazy attacker actually submits - and the
gap is called out in code rather than silently accepted.

## Consequences

* Every retry is auditable: `webhook_deliveries` for one event/endpoint pair
  reads as a complete timeline (attempt 1 failed with X at T0, attempt 2
  failed with Y at T1, attempt 3 delivered at T2), never a single row whose
  history was overwritten in place.
* A merchant's broken endpoint costs that merchant's other webhooks nothing
  once the disable threshold trips - it does not degrade delivery to anyone
  else, since `consecutive_failures` and `enabled` are per-endpoint.
* `WebhookDispatcher.runOnce` is safe to call from a single poll loop
  (`apps/worker`) on a fixed interval, or from several worker instances
  concurrently - every write that matters (claiming a delivery, upserting an
  attempt row, disabling an endpoint) is a conditional/idempotent database
  operation, not an in-memory decision.
* Proven in `packages/webhooks/test/dispatcher.test.ts`: fan-out to enabled
  subscribed endpoints, retry backoff and eventual `EXHAUSTED`, auto-disable
  plus bulk `ABANDONED`, and stale-`IN_FLIGHT` crash recovery each have a
  dedicated test.
