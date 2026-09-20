# ADR 0011 - Rate limiting: fixed-window Redis counters, per-route guard placement, identity over IP where one exists

Status: Accepted
Date: 2026-09-10

## Context

Phase 8 (README roadmap) calls for rate limiting alongside RBAC, audit,
secrets management and a signing service. Rate limiting was picked first: it
closes a real gap (nothing throttled `POST /v1/auth/login` beyond
`AuthService`'s per-account lockout, and nothing throttled request volume at
all) and the config surface for it - `RATE_LIMIT_API_PER_MINUTE`,
`RATE_LIMIT_AUTH_PER_MINUTE`, `RATE_LIMIT_INVOICE_CREATE_PER_MINUTE`,
`RATE_LIMIT_TRUST_PROXY`, `REDIS_URL`, `REDIS_CACHE_DB` - already existed in
`AppConfig`/`.env.example`, unused, since an earlier phase. Three questions
had to be settled before writing the guard.

## Decisions

### A fixed window, not a sliding one

`RateLimiter.consume` (`packages/security/src/rate-limiter.ts`) is one
`EVAL` running `INCR` then `PEXPIRE` on first increment. This allows up to
`2x limit` requests across a window boundary (a burst just before expiry,
then a fresh window immediately after) - a sliding-window log does not have
that gap. Fixed-window is accepted anyway because:

* It is O(1) - one counter per key - where a sliding log needs a sorted set
  pruned on every request.
* This is abuse throttling, not a billing meter or a correctness guarantee
  the ledger depends on. Occasionally allowing 2x for one window at a
  boundary is a rounding error for that purpose, not a financial defect - a
  materially different bar from this codebase's money-handling code, where
  no such rounding would be acceptable.
* `INCR`+`PEXPIRE` in one `EVAL` (not two round trips) still matters for a
  different reason: two separate calls would leave a key with a counter but
  no TTL if the process died in between, and a counter that never expires is
  a permanently-locked-out caller, not a rate limit.

### The guard is attached per-controller, not global

`RateLimitGuard` (`apps/api/src/common/rate-limit.guard.ts`) is added to each
controller's own `@UseGuards(...)` list, after its existing auth guard - the
same explicit, per-controller style `MerchantRoleGuard`/`PlatformRoleGuard`
already use in this codebase, rather than a Nest `APP_GUARD` applied to every
route implicitly.

This was not just a style choice: a global guard runs *before* any
controller-level guard on the same request, so `RateLimitGuard` would see
`request.merchantContext`/`userContext` as always empty and could only ever
key by IP - it would run too early to know which API key or user is calling.
Keeping it explicit and last in each controller's guard list means it runs
after `ApiKeyGuard`/`JwtAuthGuard` have already populated that context.

The cost is mechanical: every controller needed one line added. The
alternative - making the guard IP-only so it could be global - was rejected
because IP-only throttling for `'api'` would put every merchant behind the
same NAT/egress IP in one shared bucket, which is a worse failure mode than
one line of boilerplate per controller.

### Three profiles, not one limiter for everything

`RateLimit('api' | 'auth' | 'invoiceCreate')` picks both the config value and
the identity a request is keyed by:

| Profile | Config | Keyed by | Why its own bucket |
|---|---|---|---|
| `api` (default) | `RATE_LIMIT_API_PER_MINUTE` | API key id, else session user id, else IP | General ceiling; a leaked/abused API key throttles only that key, not the merchant's other keys or unrelated callers |
| `auth` | `RATE_LIMIT_AUTH_PER_MINUTE` | IP | Login/refresh happen before any identity exists; this is the volumetric backstop behind `AuthService`'s per-account lockout, not a replacement for it |
| `invoiceCreate` | `RATE_LIMIT_INVOICE_CREATE_PER_MINUTE` | Merchant id | Invoice creation is the one write cheap enough to spam into pooled-address exhaustion (ADR 0006); worth separating from the general `api` bucket so it can be tuned independently |

A rejected request still increments the counter (see `RateLimiter.consume`)
- it is a limiter, not a queue that could be retried into eventually
succeeding for free.

### `RATE_LIMIT_TRUST_PROXY` fixes a second, pre-existing gap

Wiring `RATE_LIMIT_TRUST_PROXY` into `FastifyAdapter({ trustProxy })`
(`bootstrap.ts`) - previously hardcoded `false` - was necessary for
IP-keyed rate limiting to mean anything behind a load balancer. It also
fixes a latent correctness gap in `ApiKeyGuard`'s IP allowlist check, which
already read `request.ip` for `ipAllowlist` enforcement: without
`trustProxy`, that check was silently comparing against the load balancer's
IP in any deployment with one in front of it, not the merchant server's.

## Consequences

* `packages/security/test/rate-limiter.test.ts` is a live-Redis integration
  test (same "fail rather than skip" posture as the database integration
  tests) covering the counter, window reset, and per-key independence.
* `apps/api/test/rate-limit.e2e.test.ts` drives a real 429 end-to-end through
  `AuthController`, using its own `APP_CONFIG` override (a tiny
  `rateLimitAuthPerMinute`) and a synthetic `X-Forwarded-For` identity per
  case, specifically so it does not collide with the rest of the e2e suite -
  every other e2e file now runs against an effectively unlimited rate limit
  (`apps/api/test/setup-env.ts`), since they all share one real Redis and one
  loopback IP.
* `Retry-After` is set on every 429 response (`AppExceptionFilter`), so a
  well-behaved client backs off for the right duration instead of retrying
  immediately.
* Not covered by this phase: a per-API-key override of the default limits
  (some merchants may need a higher ceiling than others), and rate limiting
  on the not-yet-built `apps/web` frontend's own endpoints - both deferred
  until there is a concrete need.
