# ADR 0019 - Observability: pino JSON logs through `@gateway/security`'s redaction, prom-client metrics on a separate port

Status: Accepted
Date: 2026-09-11

## Context

Phase 9.5 closes the prerequisites for Phase 10 (Kubernetes, monitoring,
backup, DR, CI/CD). Before this pass there was no metrics surface anywhere in
the repo (`prom-client` was not a dependency of anything, no service exposed
`/metrics`), and logging was Nest's default text `Logger` in `apps/api` plus
13 scattered `console.*` calls across `apps/worker` and
`apps/blockchain-monitor`. Neither is wrong on its own for a single developer
watching a terminal, but neither is scrapeable, parseable, or correlatable
across four processes, which is what "monitoring" in the Phase 10 roadmap
line actually requires as a foundation. Three questions had to be settled
before writing any code.

## Decisions

### One new package (`@gateway/observability`), not four copies of the same code

`apps/api`, `apps/worker`, `apps/blockchain-monitor` and `apps/web` all need
the same three things - structured logging, a metrics registry, and an ops
HTTP endpoint - but have different HTTP frameworks (Nest+Fastify, none,
none, Next's custom server) and different failure domains. A shared package
holding the framework-agnostic pieces (`createLogger`, `createHttpMetrics`,
`createPollLoopMetrics`, `startOpsServer`) with a thin, framework-specific
integration file per service (`bootstrap.ts`'s fastify hooks for `apps/api`,
`server.js`'s `http.Server` wrapper for `apps/web`) was the only option that
does not either duplicate the redaction-sensitive logging code four times or
force a single framework's shape onto services that do not use it.

### Logging goes through `@gateway/security`'s `redact()`, never a second path

Principle #8 ("secrets are never logged") already has one implementation:
`packages/security/src/redaction.ts`. `@gateway/observability`'s `createLogger`
adds no redaction rules of its own - every place data can reach a pino log
line (the merge object, `mixin()`'s output, child-logger bindings, the
message string, printf-style arguments) is routed through the same
`redact()`, so a new sensitive-field pattern only ever needs to be taught to
one function. Two non-obvious things had to be worked around to make this
true in practice, both found by `packages/observability/test/logger.test.ts`
actually asserting on redacted output rather than on call counts:

* pino's `formatters.bindings` runs for the *base* logger's own bindings but
  **not** for `.child(bindings)` - a plain `logger.child({ apiKey })` would
  reach the log line unredacted. `createLogger` returns the pino instance
  wrapped in a `Proxy` that intercepts `.child(...)` (recursively, so a
  child's own child is covered too) and redacts the bindings before pino
  ever sees them, rather than trusting every future call site to remember to
  redact its own bindings manually.
* pino ships a default serializer for a merge-object key literally named
  `err` that re-derives `type` from `err.constructor.name`. Errors are
  flattened to plain objects (`serializeError`) before reaching pino, so
  they survive `redact()`'s string-shape rules and keep their stack (`redact()`
  on a real `Error` instance keeps only `name`+`message`, which would throw
  the stack away) - but pino's default `err` serializer then stamped
  `type: 'Object'` over the already-correct flattened shape. `serializers: {
  err: (v) => v }` disables it.

### `/metrics` on a separate port, not the public listener, and not a guard

Three ways to protect `/metrics` were considered: a bearer-token guard on the
existing public route, an IP allowlist, or a separate port entirely. A
separate port was chosen for every service:

* It needs no shared secret to provision and rotate for a metrics scraper -
  the port itself is the boundary.
* It is the standard shape a Prometheus/Kubernetes setup already expects
  (a distinct container port, scraped in-cluster, never part of the public
  Service) - Phase 10's manifests can attach a `NetworkPolicy` to that port
  alone without touching the request-serving one at all.
* A guard on the public route would need to run *before* whatever auth guard
  a route normally requires (metrics scraping has no merchant session or API
  key), which is exactly the ordering hazard ADR 0011 already rejected for
  `RateLimitGuard`.

`apps/worker` and `apps/blockchain-monitor` have no other HTTP server, so
their ops port also carries `/health` and `/ready`. `apps/api` and
`apps/web` already had (or, per ADR-adjacent work this same pass, now have)
liveness/readiness on their public listener - `apps/api`'s `GET /v1/health`/
`GET /v1/ready`, `apps/web`'s `GET /health` - so their ops port carries only
`/metrics`. This is a deliberate asymmetry, not an inconsistency: liveness
and readiness answer "should traffic route here", which only makes sense
answered on the port traffic actually arrives on; `/metrics` answers a
completely different question ("what did this process do"), asked by a
different caller (a scraper, not a load balancer), so it does not need to
share a port with either.

The mechanism has a real limit worth naming: `EXPOSE`/a separate port is a
*convention*, not enforcement - nothing stops a misconfigured Kubernetes
`Service`/Docker Compose `ports:` mapping from publishing the metrics port
anyway. Actual enforcement (a `NetworkPolicy` restricting which pods may
reach it) is Phase 10 work; this ADR's job was to make sure the port split
exists for Phase 10 to enforce, not to enforce it here.

### Poll-loop metrics, not just HTTP metrics

`apps/worker` and `apps/blockchain-monitor` serve no request traffic - the
question that matters operationally for them is not "requests/sec" but "is
the loop still making progress". `createPollLoopMetrics` gives every tick
four series: duration, items processed, a gauge of the last successful
tick's timestamp (the actual alerting primitive - `time() -
gateway_worker_last_success_timestamp_seconds{loop="expiry"} > N` catches a
wedged loop that stops throwing but also stops finishing), and an error
counter. `apps/blockchain-monitor` additionally exposes
`gateway_monitor_scan_lag_blocks{network}` - `chainTip - lastProcessedBlock`
from `ChainScanner.tick()`'s own return value, so falling behind a fast
chain (`.env.example`'s `MONITOR_MAX_LAG_BLOCKS` already documented this as
a thing worth alerting on, with nothing wired to it before this pass) is a
number an alert rule can threshold on directly, independent of whether any
given tick happened to find a candidate transaction.

### Request id: adopted from the caller when well-formed, generated otherwise

`X-Request-Id` is accepted from an inbound request so `apps/web`'s call into
`apps/api` (and a merchant's own request tracing) can correlate across
services, but only when it matches `^[A-Za-z0-9._:-]{1,128}$`
(`resolveRequestId`) - it is attacker-controlled input that gets echoed back
in every response and log line of the request, so an unbounded or
free-text value is replaced with a fresh UUID rather than trusted. The id is
carried through `AsyncLocalStorage` (`request-context.ts`), which is what
lets a log line written deep inside a service - or `AppExceptionFilter`,
which already put a `request_id` in every error response before this pass -
carry it without threading it through every function signature.

### Graceful shutdown drains the HTTP server before tearing down providers - not `app.close()`'s own order

Task 4 of this pass required `apps/api` to stop accepting new connections,
wait for in-flight requests to finish, and only then disconnect. The
straightforward implementation - `app.enableShutdownHooks(['SIGTERM'])` and
nothing else - turns out to do the steps in the wrong order for that
requirement: Nest's `NestApplicationContext.close()` runs every
`onModuleDestroy()` hook (`RedisLifecycle.quit()`, `PrismaLifecycle.$disconnect()`)
*before* `NestApplication`'s own `dispose()` closes the HTTP adapter. An
in-flight request that still needs the database would have it pulled out
from under it mid-response.

`main.ts` instead drives the two phases itself: it calls
`app.enableShutdownHooks()` with no `signals` argument (so Nest attaches no
listener of its own) and registers its own `SIGTERM`/`SIGINT` handlers that
first `await app.getHttpAdapter().close()` - fastify's own close, which
drops idle keep-alive connections immediately but waits for a request
already being handled to finish, bounded by a race against
`SHUTDOWN_TIMEOUT_MS` - and only afterward calls `app.close()`, whose
`onModuleDestroy` hooks now run against an HTTP server that has already
finished draining. `apps/worker` and `apps/blockchain-monitor` do not have
this hazard - both already finish their current tick before exiting the
poll loop, and the database connection they hold is theirs alone, not
shared with in-flight request handlers - so their existing
`AbortController`-based shutdown needed no reordering, only the ops-server
`close()` added alongside it.

Live verification against a real container (`docker kill --signal=TERM` on a
`gateway-debug` image built from `infrastructure/docker/Dockerfile`, `node`
itself as PID 1 so the exit code observed is the application's own) surfaced
a real bug this design would otherwise have masked: `RedisLifecycle`'s
`onModuleDestroy()` called `this.client.quit()` unconditionally, and ioredis
throws - synchronously, not a rejected promise - `Error: Connection is
closed` when called on a connection already in `'close'`/`'end'` state (an
idle Redis connection dropped before shutdown began, reproduced twice in a
row). Uncaught, that throw becomes an unhandled rejection inside Nest's
`onModuleDestroy` hook runner and crashes the process (Node's default for an
unhandled rejection) instead of exiting 0 - the exact failure mode a
graceful shutdown exists to prevent, now triggered *by* the shutdown path
itself. `main.ts`'s own `try/catch` around `app.close()` stops it from
taking the whole process down, but `RedisLifecycle.onModuleDestroy()` was
hardened directly (check `client.status` first; swallow only that specific,
already-closed error) rather than leaving every future caller of
`app.close()` responsible for remembering the wrapper - the same reasoning
ADR 0012 and this ADR's redaction section both lean on: a guarantee enforced
at its one source is worth more than a convention every call site has to
honor correctly.

**Correction (ADR 0021 audit):** the container this test ran against was
`gateway-debug` - the `debug` Docker target, which deliberately skips
`pnpm prune --prod` and therefore was never affected by the runtime-image
bug ADR 0021 documents. That made the finding above real and worth keeping,
but it verified the application's shutdown *code*, not the *runtime image*
(`api`/`worker`/`monitor`/`web`) - at the time this was written, the runtime
image did not actually run at all (see ADR 0021). Re-running the identical
`docker kill --signal=TERM` test against the real `api` runtime image (not
`debug`) surfaced a second, independent bug this first round of testing
could not have caught, because it only manifests when Nest's own
`enableShutdownHooks()` machinery is exercised end-to-end in a process that
also has this file's own signal handlers competing with it: `main.ts` called
`app.enableShutdownHooks()` with no arguments on the belief that this
attached no signal listeners of Nest's own (the comment above this line, now
corrected in the source, said as much) - NestJS's implementation instead
reads an empty/omitted `signals` array as "listen for every
`ShutdownSignal`". The result was two competing `SIGTERM` handlers: Nest's
own ran `onModuleDestroy` on every provider immediately, finished faster
than this file's own drain-then-close sequence, and then re-raised the same
signal via `process.kill(process.pid, signal)` - which this file's
`process.once('SIGTERM', ...)`, already fired and self-removed on the first
delivery, no longer caught, so Node's default disposition for the second,
now-unhandled delivery terminated the process outright (observed: exit 143,
the process vanishing right after logging "received shutdown signal", never
reaching "shutdown complete" - reproduced identically via `docker kill`
through tini and via `kill -TERM` sent directly to the Node PID, which is
what ruled out a tini/signal-forwarding explanation). Fixed by removing the
`enableShutdownHooks()` call: `app.close()` already runs every
destroy/shutdown hook on its own, with or without it - see ADR 0021 for the
full account. Re-verified against the fixed `api` runtime image: the same
mid-request `SIGTERM` now drains the in-flight request to completion and
exits 0.

## Consequences

* `packages/observability/test/*.test.ts` (24 tests) covers the redaction
  guarantees above directly (a real JWT/API-key-shaped/webhook-secret-shaped
  string must never appear in emitted output), the poll-loop and HTTP metric
  shapes, and the ops server's `/health` vs `/ready` split (readiness times
  out a hung check rather than hanging the probe, and reports 503 once
  `markShuttingDown()` is called).
* `apps/web`'s HTTP-metrics route label is a hand-maintained allowlist
  (`server.js`'s `KNOWN_ROUTES`), not the framework's own matched-route
  template the way `apps/api`'s fastify hook reads one: a custom
  `http.Server` sees a request before Next has resolved it to a page, and
  `apps/web`'s route set is small and changes rarely enough that this is a
  reasonable trade against the cardinality blowup a raw `req.url` would
  cause on `/pay/:invoiceId`.
* `apps/web`'s `/metrics`/HTTP-metrics wiring lives in `server.js`, which only
  runs in the production Docker image (`node server.js`) - `pnpm dev:web`
  (`next dev`) does not go through it, so metrics are a production-only
  concern for this service, unlike `apps/api`/`apps/worker`/
  `apps/blockchain-monitor`, whose `dev` script runs the same `main.ts` that
  production does.
* `OTEL_ENABLED`/`OTEL_EXPORTER_OTLP_ENDPOINT`/`OTEL_SERVICE_NAME` remain in
  `.env.example`, unread by any code - distributed tracing is explicitly
  deferred, not implemented partially. Do not infer tracing works from their
  presence.
* Not covered by this pass: per-merchant/per-API-key metric labels (would
  make cardinality a function of merchant count, which is unbounded);
  log/metric shipping to a real backend (Loki, a managed Prometheus) -
  that is Phase 10's job once there is a cluster to ship to.
