# ADR 0016 - Security testing: 36 new e2e tests, a test-infra gap that had silently disabled all DTO validation, a misclassified 413, one dependency vulnerability neutralized, and one left open

Status: Accepted
Date: 2026-09-10

## Context

Phase 9 (README roadmap) calls for unit, integration, E2E, security, and load
testing. ADR 0015 (both halves - cross-package integration testing and load
testing) explicitly left "dedicated security testing (fuzzing, authz-boundary
probing beyond what the e2e suites incidentally check)" as the one still-open
Phase 9 item. This ADR covers that pass.

Before writing new tests, a review of the existing surface (guards,
permissions, SSRF guard, JWT implementation, exception filter, CORS/helmet
wiring) found the authorization model itself well-built and already
extensively tested per-feature (every merchant-scoped controller already had
its own cross-merchant/role e2e tests; see `merchant-api-keys.e2e.test.ts`,
`invoices.e2e.test.ts`, `merchant-members.e2e.test.ts`, etc.). The gaps were
narrower and more specific than "authorization is untested" - they are listed
below.

## Decisions

### Five new files under `apps/api/test/security/`

1. **`api-key-lifecycle.e2e.test.ts`** - `ApiKeyGuard` has several rejection
   branches (revoked, expired, mid-rotation past grace period, IP allowlist,
   inactive merchant) that no existing e2e test exercised end-to-end; every
   prior suite only ever hit the "valid key" and "malformed bearer" paths.
2. **`access-control.e2e.test.ts`** - two access-control gaps distinct from
   what per-feature suites already covered: (a) three admin endpoints
   (reconciliation resolve, refund approve/reject, settlement listing) had no
   test asserting an under-privileged platform role is actually rejected -
   only the happy path was exercised, even though the `@RequirePlatformPermission`
   wiring was already correct; (b) "resource-ID confusion" - a merchant
   sending its OWN valid `X-Merchant-Id` header (so `MerchantRoleGuard`
   passes) but a resource id belonging to a DIFFERENT merchant, which tests
   each service's `findFirst({ id, merchantId })` ownership check rather than
   just the header check already covered elsewhere.
3. **`auth-token-forgery.e2e.test.ts`** - forges an "alg: none" token, a token
   signed with a guessed secret, a legitimately-issued token with its payload
   hand-edited to escalate `platform_role`, an expired token, and
   wrong-issuer/audience tokens against `JwtAuthGuard`. Also documents (not
   asserts as a bug) that a still-valid access token keeps working for up to
   `JWT_ACCESS_TTL_SECONDS` after the account is suspended - `JwtAuthGuard` is
   deliberately stateless (see its own doc comment), and `AuthService.refresh`
   already blocks extending that window.
4. **`input-and-data-exposure.e2e.test.ts`** - mass-assignment attempts
   (extra fields like `merchant_id`, `status`, `platform_role` in request
   bodies), SQL/script-injection-shaped free text in invoice fields (proving
   Prisma stores it as inert data, never executes it), garbage/path-traversal-
   shaped resource ids, and a sweep asserting no dashboard response ever
   serializes a password hash, API-key secret hash, or webhook secret.
5. **`http-hardening.e2e.test.ts`** - boots the real `bootstrap.ts#createApp()`
   instead of `create-test-app.ts` (which never registered `@fastify/helmet`/
   `@fastify/cors`/the body-limit content-type parser - see that file's own
   comment on why), specifically to assert helmet headers, CORS origin
   handling, and the 256KB body limit actually apply. No e2e test anywhere
   had asserted any of this before.

## Findings

### 1. Test-infrastructure gap: Vitest's esbuild transform silently disabled `ValidationPipe` in every existing e2e test

While writing the mass-assignment tests, a request with unexpected extra
fields returned `201` instead of `400`. Investigating further: a request with
an **empty body** to `POST /v1/payment-invoices` returned `500 Internal
server error` (an unhandled `TypeError` in `InvoicesService`) instead of a
clean `400 validation_failed` naming the missing fields.

Root cause: Nest's `ValidationPipe` decides which DTO class to validate a
`@Body()` against via `Reflect.getMetadata('design:paramtypes', ...)` on the
controller method - metadata TypeScript only emits with
`emitDecoratorMetadata: true` under `tsc`. Vitest's default transform is
esbuild, which does not implement that flag; the same limitation is already
called out in this codebase's own comments about constructor DI
(`invoices.controller.ts` and others use explicit `@Inject(Class)` tokens
specifically because of it) but had not been noticed for `ValidationPipe`,
which depends on the identical metadata for method parameters, not
constructors.

**Verified this was never a live production bug**: `apps/api`'s real build
uses `tsc -b` (`tsconfig.base.json` has `emitDecoratorMetadata: true`), and
inspecting the compiled `dist/invoices/invoices.controller.js` confirmed
`__metadata("design:paramtypes", [Object, CreateInvoiceDto, String])` is
correctly emitted there. Production `ValidationPipe` behaviour was correct
the entire time; only the test suite's own transform pipeline blinded it to
that fact.

**Fix**: `apps/api/vitest.config.ts` now transforms test files through
`unplugin-swc`/`@swc/core` (new devDependencies, root-level) configured with
`decoratorMetadata: true`, instead of esbuild. Re-ran the entire pre-existing
e2e suite afterward with real validation now active: all 24 pre-existing
files / 105 pre-existing tests passed unchanged, confirming the DTOs
themselves needed no fixes - only the harness did. This also means every one
of the 5 new files' mass-assignment/injection assertions are now backed by a
harness that actually enforces `whitelist`/`forbidNonWhitelisted`, not one
that silently no-ops it.

### 2. Real bug: an oversized request body was misclassified as a 500, not a 413

`bootstrap.ts` enforces a 256KB body limit via a custom Fastify content-type
parser. Sending a larger body correctly gets rejected by Fastify itself (a
`FastifyError` with `code: FST_ERR_CTP_BODY_TOO_LARGE`, `statusCode: 413`) -
but `AppExceptionFilter` only recognised `AppError` and Nest's own
`HttpException`; a raw Fastify-level error (thrown during body parsing,
before Nest's pipeline runs) matched neither, so it fell into the generic
"anything else is a bug" branch: the client got `500 Internal server error`
instead of `413`, and the rejection was logged at error level as if it were
an application bug rather than the expected, correct rejection it is.

**Fix**: `AppExceptionFilter` now recognises any `Error` carrying a numeric
4xx `statusCode` (the convention Fastify's own errors use) and maps it
through with that status, before falling to the generic 500 branch. Confirmed
fixed via `http-hardening.e2e.test.ts`.

### 3. Documented, not fixed: API-key `scopes` are stored and returned but never enforced

`CreateApiKeyDto.scopes` (e.g. `invoices:read`, `invoices:write`) is
client-chosen at key creation, stored, and returned by every read endpoint -
but no guard or decorator anywhere checks `MerchantContext.scopes` against
anything. A key created with only `invoices:read` can still call
`POST /v1/payment-invoices` (a write). `input-and-data-exposure.e2e.test.ts`
has a test explicitly named `KNOWN GAP: ...` asserting today's (unenforced)
behaviour, so this shows up in the suite instead of only in this writeup.

Deliberately not fixed here: closing it means deciding a scope-to-endpoint
mapping across every `ApiKeyGuard`-protected controller (invoices,
transactions, addresses), which is a cross-cutting authorization change, not
a testing-pass fix, and deserves its own decision.

### 4. Dependency audit: one critical/high cluster neutralized, one major cluster requires a NestJS upgrade this pass deliberately did not attempt

`pnpm audit --prod` reported 17 advisories (1 critical, 9 high, 6 moderate, 1
low) before this pass. `pnpm why` traced all of the critical/high ones to two
distinct roots:

* **`@fastify/middie` (1 critical + 3 high)** - `@nestjs/platform-fastify`
  unconditionally registers `@fastify/middie` on `app.init()` regardless of
  whether the app ever calls `app.use()` (see `FastifyAdapter.init()`'s
  `registerMiddie()` call). This app never does. **Fixed**: both
  `bootstrap.ts#createApp()` and `test/support/create-test-app.ts` now pass
  `skipMiddie: true` to `FastifyAdapter`'s constructor (an officially
  supported option), which skips registering the plugin at all - removing
  the exposure outright rather than waiting on a transitive-dependency bump.
  Confirmed the full e2e suite (141 tests) still passes with it off.
* **`fastify`/`find-my-way`/`@nestjs/core` (the remaining ~8 high/moderate)**
  - `@nestjs/platform-fastify@10.4.22` (this app's installed version) bundles
  `fastify` as a **hard dependency pinned to `4.28.1`** (`pnpm why fastify`
  confirms the actually-running instance, distinct from the newer `fastify`
  apps/api also depends on directly for types/`FastifyAdapter` usage). Every
  one of these advisories' "patched versions" field names only a `5.x`
  threshold (e.g. `>=5.8.3`, `>=5.12.1`) - none of these fixes were ever
  backported to the 4.x line, and the latest available 4.x release
  (`4.29.1`) does not include them. The only real fix is Fastify 5, which
  for this app means upgrading `@nestjs/platform-fastify`/`@nestjs/core`
  past the 10.x line entirely (`@nestjs/platform-fastify@12.0.1`, the latest
  at the time of this pass, bundles `fastify@5.12.1`). **Not attempted in
  this pass**: a NestJS major-version upgrade is a broad, high-blast-radius
  change (guard/decorator/DI behaviour, all 25 e2e test files) that needs
  its own dedicated upgrade effort and regression pass, not something to
  fold into a testing ADR.
* **`deepmerge-ts` (1 high)** - traced to `@prisma/config`, a `prisma` CLI
  dependency used only for local/CI schema-management commands
  (`db:migrate`, `db:generate`, `seed`), never loaded by the running API
  process or reachable from an HTTP request. Real-world risk here is low
  despite the audit's own "high" label; left as a lower-priority item.

### 5. Corrected a stale/misleading doc comment

`ApiKey.ipAllowlist` was commented `/// CIDR allowlist` in
`packages/database/prisma/schema.prisma`, but `ApiKeyGuard` does an exact
string match (`record.ipAllowlist.includes(clientIp)`), never CIDR range
parsing - an operator entering `"203.0.113.0/24"` there would silently match
nothing, ever. Comment corrected to describe the actual (exact-match)
behaviour; no code change, since nothing currently depends on CIDR matching
working (it never did).

## Consequences

* `apps/api/vitest.config.ts` now transforms through SWC; every e2e test,
  existing and future, exercises real `ValidationPipe` behaviour instead of
  a silently-disabled one. New root devDependencies: `unplugin-swc`,
  `@swc/core`.
* `AppExceptionFilter` correctly maps any Fastify-native 4xx error to its
  real status - affects any future Fastify-level rejection, not just the
  256KB body-limit case this pass tested.
* `bootstrap.ts` and `create-test-app.ts` both pass `skipMiddie: true`,
  removing `@fastify/middie` from the request pipeline entirely.
* `packages/database/prisma/schema.prisma`'s `ipAllowlist` comment corrected
  (no schema/behaviour change).
* README roadmap's Phase 9 row now credits all five sub-items (unit,
  integration, E2E, security, load) as done.
* **Follow-ups intentionally left open, in priority order**:
  1. Plan a NestJS 10 → 12 upgrade (or at least past the Fastify-4-bundling
     10.x line) specifically to close the fastify/find-my-way/@nestjs/core
     advisory cluster in finding 4 - the highest-priority item, since this
     is exactly the kind of thing a third-party security audit
     (or due-diligence review) would flag immediately via automated
     dependency scanning.
  2. Decide and implement API-key scope enforcement (finding 3), or
     explicitly document scopes as informational-only if enforcement is
     never planned.
  3. Re-run `pnpm audit --prod` after the NestJS upgrade to confirm the
     cluster actually clears, and re-evaluate `deepmerge-ts`/`@prisma/config`
     at that point too.
* Not attempted: fuzzing/property-based input testing beyond the payload
  sets used here, and load-testing-style concurrent-attacker simulation
  (out of scope for this pass; ADR 0015 already covers concurrency under
  legitimate load).
