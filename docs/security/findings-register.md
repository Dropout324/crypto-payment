# Security findings register

Status: living document. Pass 1 written and closed 2026-09-13 (ADR 0031);
Pass 2 (Tier 2 feature attack surface: Phases 12, 13, 25, 26, 27) appends to
this same file before Phase 30 runs, per the roadmap.

Labels follow the roadmap's convention: implementation status is
*implemented / tested / simulated / production-dependent*.

## How this register was built

Every area in Phase 17 pass 1's scope (`README.md#roadmap`)
was checked against the current codebase, not against the roadmap's own
"known starting gaps" list on trust - that list is dated 2026-09-11 and this
review re-verified each item independently (see the "re-verified" note on
each finding below). Every fix claimed as closed is backed by an actual test
run cited next to it; nothing here is closed on inspection alone (Rule 1).

## Summary

| # | Area | Severity | Status before this pass | Status after this pass |
|---|---|---|---|---|
| 1 | Dependency/supply-chain (Fastify/Nest advisories) | Critical | 1 critical, 9 high (17 total) | **0 critical, 0 high, 0 moderate, 0 low** |
| 2 | API-key scopes not enforced | High | Stored, never checked | **Enforced end-to-end, tested** |
| 3 | Test/live key vs network separation | High | Not enforced | **Enforced end-to-end, tested** |
| 4 | Database role is a superuser | High | `gateway` (superuser) used for everything | **Least-privilege `gateway_app` role for runtime traffic, tested** |
| 5 | Post-suspension token/session validity | Medium | Documented, not mitigated | **Merchant-level: mitigated (immediate). User-level: accepted, bounded, documented** |
| 6 | No formal threat model | Low (process) | Absent | **`docs/security/threat-model.md` written** |
| 7 | Audit log listing hides recent events past the first page | Medium | Present, mislabelled as a "write race" (ADR 0025/0030) | **Fixed: newest-first ordering** |
| 8 | SSRF guard DNS-rebinding TOCTOU | Medium | Documented limitation | Unchanged - carried forward, see finding |
| 9 | Everything else reviewed | - | - | No new finding; see per-area notes below |

## Findings

### 1. Production dependency advisories (Critical)

- **Impact**: `@fastify/middie` (bundled transitively by
  `@nestjs/platform-fastify@10.4.22`) had a critical middleware
  authentication-bypass advisory, plus 9 high advisories in the same
  dependency chain (path-normalization bypass, HTTP/2 DDoS via
  `find-my-way`, a Fastify content-type validation bypass, and Nest's own
  Fastify trailing-slash/HEAD-request middleware bypasses).
- **Exploit scenario**: an attacker crafts a request that a middleware
  layer (CORS, helmet, auth) is supposed to see, but a URL-normalization or
  middleware-scoping bug lets it skip that layer and reach a route handler
  unauthenticated, or trips a DoS via crafted HTTP/2 frames.
- **Re-verified**: `pnpm audit --prod --json` on 2026-09-13 reproduced
  exactly the roadmap's stated count (1 critical, 9 high, plus 6 moderate
  and 1 low = 17 total) before any change.
- **Mitigation (implemented, tested)**: `@nestjs/common`,
  `@nestjs/core`, `@nestjs/platform-fastify`, `@nestjs/testing` upgraded
  10.4.15 → 11.2.3 (the first 11.x patch past the last vulnerable
  `@nestjs/platform-fastify` release, 11.1.23, and past the point where
  Nest stopped bundling `@fastify/middie` at all - removing that dependency
  chain entirely rather than patching it). `@fastify/cookie`,
  `@fastify/cors`, `@fastify/helmet` upgraded to their Fastify-5-compatible
  majors (11.1.2, 11.3.0, 13.1.1 respectively - the previous versions
  targeted Fastify 4.x and failed to boot at all once the framework moved
  to 5, `@fastify/helmet: expected '4.x' fastify version, '5.x' is
  installed`, caught by `test/security/http-hardening.e2e.test.ts`
  actually failing to boot, not by inspection). Root `package.json` gained
  `pnpm.overrides` for `deepmerge-ts` (7.1.5 → ^8.0.2, a high-severity
  stack-exhaustion advisory via `prisma`'s own config loader - a dev/CLI
  path, but still flagged under `--prod` since `prisma` is a production
  dependency of `@gateway/database`) and `fastify` (pinned to ^5.12.4,
  closing the 2 remaining moderate advisories in the copy
  `@nestjs/platform-fastify` bundles internally at 5.11.3).
- **Evidence**: `pnpm audit --prod --json` after the upgrade:
  `{"info":0,"low":0,"moderate":0,"high":0,"critical":0}`. `pnpm --filter
  @gateway/api typecheck` and `build` both clean. Full `apps/api` test
  suite re-run after the upgrade (see the Phase 17 ADR's evidence section
  for the exact run); the only failure found was the unrelated,
  independently-diagnosed audit-log ordering bug (finding 7), which this
  same pass also fixed.
- **Status**: implemented, tested. Zero unresolved critical/high advisories -
  the roadmap's exit criterion holds without risk acceptance.

### 2. API-key scopes stored but never enforced (High)

- **Impact**: `ApiKey.scopes` (e.g. `["invoices:read"]`) was accepted at
  creation, stored, and returned in every response, but no code path ever
  compared a presented key's scopes against the endpoint it called. A
  merchant that issued a deliberately read-only integration key (for a
  reporting tool, say) got no actual restriction - that key could create
  invoices, register deposit addresses, and everything else, identically to
  a full-access key.
- **Exploit scenario**: a merchant hands a "read-only" key to a third-party
  analytics vendor, believing `scopes: ["invoices:read"]` limits what that
  vendor's compromised or malicious code can do. It does not - the vendor
  can create invoices, register addresses, or call the webhook test
  endpoint under the merchant's identity.
- **Re-verified**: read `apps/api/src/auth/api-key.guard.ts` (attaches
  `scopes` to `request.merchantContext` and does nothing else with it) and
  grepped every controller behind `ApiKeyGuard` - none referenced
  `merchantContext.scopes` before this pass.
- **Mitigation (implemented, tested)**: `ApiKeyScopeGuard` +
  `@RequireScope(...)` (`apps/api/src/auth/api-key-scope.guard.ts`), the
  same `Reflector`/`SetMetadata` pattern `MerchantRoleGuard`/
  `PlatformRoleGuard` already use, applied to every `ApiKeyGuard`-protected
  controller: invoices (read/write), addresses (read/write), transactions
  (read), balance (read), merchant-transactions (read), webhook test
  (write). `CreateApiKeyDto.scopes` now validates against a fixed allowlist
  (`ALL_API_KEY_SCOPES`) via `@IsIn` - an unrecognised scope string is
  rejected at creation (400), not silently accepted and never enforceable.
  Omitting `scopes` at creation still grants every scope (unchanged
  behaviour for existing integrations that never set it), so this is
  additive, not a breaking default change.
- **Evidence**: `apps/api/test/security/api-key-scopes.e2e.test.ts` (7
  tests, all passing) - an under-scoped key is rejected with 403 and the
  missing scope named in the response; a correctly-scoped key succeeds;
  the dashboard create-key endpoint defaults to full access when `scopes`
  is omitted and rejects an unrecognised scope string with 400.
- **Status**: implemented, tested. Enforced end-to-end - the "or removed
  from the API surface" alternative in the exit criterion was not needed.

### 3. Test/live key and network separation not enforced (High)

- **Impact**: `ApiKey.livemode` was set at creation (`pk_test_...` vs
  `pk_live_...`) and returned in responses, but neither invoice creation
  nor deposit-address registration checked it against the network named in
  the request. A test-mode key could create a real mainnet invoice
  (assigning a real deposit address, generating a real webhook, and
  eventually crediting a real ledger balance from a real customer
  payment); a live key could register or invoice against a testnet.
- **Exploit scenario**: a developer accidentally ships a `pk_test_...` key
  in a production build (a common integration mistake this control exists
  specifically to catch) - without this check, that mistake creates real
  mainnet invoices under a "test" key with no warning, and a compromised or
  leaked test key can be used to interact with real merchant mainnet
  infrastructure it should never be able to reach.
- **Re-verified**: read `invoices.service.ts::createInvoice` and
  `addresses.service.ts::register` in full - neither referenced
  `merchant.livemode` before this pass, despite both already having
  `NetworkConfig.isTestnet` available from `getNetworkConfig()`.
- **Mitigation (implemented, tested)**: `assertNetworkMatchesLivemode`
  (`packages/shared/src/domain/network.ts`) - `livemode=true` may only
  target `isTestnet=false` networks and vice versa - called from both
  `invoices.service.ts` and `addresses.service.ts` immediately after
  network validation, before any other work (asset lookup, exchange rate,
  address-pool reservation) happens. A new `ErrorCode.NETWORK_LIVEMODE_MISMATCH`
  (403) makes the rejection explicit and machine-readable rather than
  reusing a generic error.
- **Why `apps/blockchain-monitor` needed no separate change**: the known
  gap named the monitor explicitly ("livemode is... not used by... monitoring").
  Re-investigated: the monitor has no concept of API keys at all - it
  watches `payment_addresses`/`invoices` rows by their own `network`
  column, which is intrinsic to the record and always matches the RPC
  endpoint configured for that network. Once creation-time enforcement
  guarantees every invoice/address's `network` is consistent with the
  merchant key that created it, there is no remaining path for the monitor
  to watch "the wrong chain" - the inconsistency this gap described can no
  longer be created in the first place.
- **Evidence**: `apps/api/test/security/livemode-network-separation.e2e.test.ts`
  (6 tests, all passing) - both directions (test-mode key vs mainnet,
  live key vs testnet), both endpoints (invoice creation, address
  registration), plus both matching-direction positive cases.
- **Status**: implemented, tested, both directions.

### 4. No least-privilege PostgreSQL role for the application (High)

- **Impact**: every service (`api`, `worker`, `blockchain-monitor`)
  connected to Postgres as `gateway` - the same role that owns the schema
  and runs migrations, and (per `infrastructure/kubernetes/postgres.yaml`'s
  own comment) a superuser, needed there only so `pg_basebackup`/streaming
  replication for point-in-time recovery (ADR 0029) has a role to
  authenticate as. A SQL-injection bug, a compromised dependency executing
  arbitrary queries, or a mistaken raw-SQL migration run through the
  application connection had no database-enforced ceiling: DDL, superuser
  functions, and every other schema were all reachable.
- **Exploit scenario**: a future code path that builds part of a raw SQL
  string from request-derived input (this codebase does not have one today
  - every raw query found in this review uses parameterised
  `Prisma.sql`/tagged templates or fixed literals, see finding on input
  validation below) would, if it existed, be able to drop tables or alter
  the schema, not just read/write rows - the blast radius of any future
  such bug is currently unbounded by the database itself.
- **Re-verified**: `infrastructure/kubernetes/postgres.yaml`'s own comment
  ("`gateway` being a superuser is not enough...") confirms the role is a
  superuser; `api.yaml`/`worker.yaml`/`monitor.yaml` all pull `DATABASE_URL`
  from the same `gateway-secrets` Secret via `envFrom`.
- **Mitigation (implemented, tested)**: `packages/database/prisma/provision-app-role.ts`
  creates `gateway_app` - `LOGIN` only, `NOSUPERUSER NOCREATEDB NOCREATEROLE
  NOREPLICATION` - granted `SELECT, INSERT, UPDATE, DELETE` on tables and
  `USAGE, SELECT` on sequences, with `ALTER DEFAULT PRIVILEGES FOR ROLE
  CURRENT_USER` so tables a future migration creates are covered
  automatically. `infrastructure/kubernetes/migration-job.yaml` runs it
  (idempotently, every deploy) immediately after `prisma migrate deploy`,
  using a new `DATABASE_MIGRATE_URL` secret key (the superuser connection,
  used only by that job) while `DATABASE_URL` - the key
  `api`/`worker`/`monitor` actually consume - now points at `gateway_app`.
  `gateway` remains a superuser only for migrations and PITR replication,
  never injected into a runtime service pod.
- **Evidence**: `packages/database/test/least-privilege-role.test.ts` (6
  tests, all passing, run against a real Postgres): connected as
  `gateway_app` and proved SELECT/INSERT/UPDATE/DELETE succeed on an
  existing table; `CREATE TABLE`, `ALTER TABLE`, `DROP TABLE`, and
  `ALTER ROLE ... WITH SUPERUSER` all reject with a real Postgres
  permission-denied/must-be-owner error; a table created *after*
  provisioning still grants `gateway_app` access automatically, proving
  the `ALTER DEFAULT PRIVILEGES` mechanism actually works, not just that it
  was declared.
- **Scope note**: this pass changes the Kubernetes production path only.
  Local development and the test suite continue to connect as the
  migration role directly (documented, unchanged) - `TEST_DATABASE_URL`
  needs DDL rights to run `prisma migrate deploy`, and switching it to the
  least-privilege role would make that impossible without a second
  connection string for every local workflow. The finding this pass closes
  is specifically "does the application run as a superuser in production" -
  it now does not.
- **Status**: implemented, tested (production path). Local/test dev
  connection intentionally unchanged, disclosed above.

### 5. Post-suspension token/session validity (Medium)

- **Impact, re-investigated from scratch**: the roadmap's own framing
  ("access tokens remain valid until their TTL after a merchant account is
  suspended") undersold the actual exposure. `ApiKeyGuard` already
  re-checked `merchant.status === 'ACTIVE'` on every request (a real DB
  lookup, not a JWT claim) - API-key traffic from a suspended merchant was
  already blocked immediately, before this pass. The real gap was the
  **dashboard** path: `MerchantRoleGuard` checked `MerchantMember`
  existence but never `merchant.status` - a suspended merchant's logged-in
  team members kept full dashboard access for as long as they kept their
  session alive (refreshing indefinitely), not merely for one 15-minute
  access-token TTL.
- **Exploit scenario (pre-fix)**: a platform operator suspends a merchant
  under compliance review or fraud suspicion. If that merchant's team is
  already logged into the dashboard, they can continue creating API keys,
  rotating webhook secrets, and viewing balance/transaction data
  indefinitely - the suspension has no practical effect on their own
  dashboard access at all.
- **Mitigation (implemented, tested)**: `MerchantRoleGuard`
  (`apps/api/src/auth/merchant-role.guard.ts`) now includes `merchant:
  { select: { status: true } }` in the same membership-row query it
  already ran, and rejects with 403 if the merchant is not `ACTIVE`. This
  adds no new database round trip (the query already ran); suspension now
  takes effect on the very next dashboard request, with no TTL window at
  all.
- **Evidence**: `apps/api/test/security/access-control.e2e.test.ts`, new
  `describe('dashboard access after merchant suspension')` block (2 tests):
  a dashboard request succeeds before suspension, is rejected with 403
  immediately after (same session, no re-login), and access is restored on
  reactivation.
- **Remaining, accepted risk (user-level, not merchant-level)**: `JwtAuthGuard`
  is deliberately stateless - it verifies the JWT signature/expiry and
  never queries the database, by design, to avoid a DB round trip on every
  authenticated request. If a platform admin ever suspends an individual
  `User` account directly (there is currently no API endpoint that does
  this - only merchant-level suspension exists today), that user's
  already-issued access token would remain valid until its own expiry.
  **Decision, recorded here as the roadmap requires**: accepted, not
  mitigated, bounded to `JWT_ACCESS_TTL_SECONDS` (default 900 seconds / 15
  minutes, operator-configurable). Rationale: (a) the refresh path already
  re-validates `user.status === 'ACTIVE'` on every token refresh
  (`auth.service.ts::refresh`), so the exposure cannot extend past one
  access-token lifetime even under continuous use; (b) there is no live
  feature that suspends a `User` directly today, making this a
  forward-looking bound rather than an active gap; (c) making
  `JwtAuthGuard` stateful (a DB lookup on every dashboard request) to close
  a currently-unreachable gap would trade a real, permanent latency cost
  for a hypothetical one - not a trade this pass makes without a feature
  that actually needs it. If a future phase adds user-level suspension,
  extending `JwtAuthGuard` with the same live-status-check pattern
  `MerchantRoleGuard` now uses is the straightforward next step, or
  shortening `JWT_ACCESS_TTL_SECONDS` for a tighter bound without any code
  change.
- **Status**: merchant-level - implemented, tested. User-level - accepted
  risk, bounded and documented (max exposure: one `JWT_ACCESS_TTL_SECONDS`,
  default 15 minutes).

### 6. No formal threat model (Low, process)

- **Mitigation**: `docs/security/threat-model.md` written this pass -
  assets, actors/trust boundaries, attack surface by entry point, and what
  this and future passes change about it.
- **Status**: implemented (documentation).

### 7. Audit log listing hides recent events past the first page (Medium)

- **Not one of the roadmap's named starting gaps** - found during this
  pass's own review of the audit-logging area, which is explicitly in
  Phase 17 pass 1's scope list.
- **Impact**: `GET /v1/admin/audit-logs` ordered results ascending by `id`
  (oldest first) with standard `limit`/`cursor` pagination. Because
  `audit_logs` grows globally and without bound, once matching rows for a
  given filter exceeded the default page size (20), the newest matching
  row - the one an operator investigating "what just happened" almost
  always wants - silently fell off the end, several pages deep, with no
  indication in the response that anything was truncated in that
  direction.
- **This is the same defect previously misdiagnosed as "a plausible
  audit-log-write race"** in ADR 0025 (Phase 11) and re-confirmed as
  unresolved in ADR 0030 (Phase 16), both of which left it for "Phase
  16/17". Re-investigated here: `apps/api/test/admin-audit-logs.e2e.test.ts`
  suspends a merchant and immediately queries for that exact
  `resource_type`/`action` pair, expecting to find it. Counting rows
  directly against the shared local test database found 47 pre-existing
  `merchant.suspended` audit rows from the many prior test runs this
  long-lived shared database has accumulated (`gateway_test` is never
  reset between runs, by design - ADR 0020) - 27 more than the 20-row
  default page, all ascending-ordered *before* the new one. Nothing was
  racing; the query was simply looking at the wrong end of the list.
- **Exploit/operational scenario**: an incident responder filters audit
  logs for a specific merchant or action while investigating a live
  incident and sees old, resolved events instead of the current one -
  actively misleading during exactly the situation this endpoint exists
  for.
- **Mitigation (implemented, tested)**: `AdminAuditLogsService.list`
  (`apps/api/src/admin/admin-audit-logs.service.ts`) now orders `id: desc`
  with a matching `lt`-cursor (was `asc`/`gt`) - newest-first, the
  convention most audit/incident tooling uses by default. This is a
  deliberate, documented exception to `pagination.ts`'s shared
  ascending-cursor convention, which fits owner-scoped resource lists
  (small per-caller row counts) but not this endpoint's unbounded global
  growth.
- **Evidence**: `admin-audit-logs.e2e.test.ts`'s previously-failing case
  now passes without any change to the test itself or to the shared,
  still-unreset test database - confirming the fix, not a change in test
  conditions.
- **Status**: implemented, tested.

### 8. SSRF guard: DNS-rebinding TOCTOU (Medium, carried forward)

- **Already documented** in `packages/webhooks/src/ssrf-guard.ts`'s own
  header comment; re-verified as still present and still the only gap in
  that guard.
- **Impact**: `assertPublicWebhookUrl` resolves the webhook hostname and
  checks the result, then lets the HTTP client resolve it again to
  actually connect. A DNS record that changes between those two lookups
  (classic DNS rebinding) could pass the check while still connecting to a
  private address.
- **Exploit scenario**: a malicious merchant registers a webhook hostname
  whose DNS answer flips from a public IP (passes the guard) to
  `169.254.169.254` or an internal address in the seconds before the
  actual delivery attempt connects.
- **Why not fixed this pass**: closing it fully requires pinning the
  resolved address for the connection itself (a custom `dns.lookup`/
  `fetch` dispatcher hook), a larger change than this pass's required exit
  criteria call for. The existing check still stops the overwhelming
  majority of real SSRF attempts (a URL that is privately-addressed from
  the start, not one actively racing DNS) at a fraction of the complexity.
- **Recommendation**: close before this system handles untrusted
  production webhook-URL traffic at meaningful scale - candidate for Phase
  17 pass 2 or a dedicated hardening item.
- **Status**: production-dependent (acceptable for current scale; not
  acceptable indefinitely). Carried forward, not this pass's finding to
  close.

## Areas reviewed with no new finding

Confirmed present, tested, and functioning as documented in prior ADRs -
re-verified by reading the current implementation, not re-typed from the
roadmap's own claims:

- **Authentication**: Argon2id password hashing, account lockout after 5
  failed attempts (15-minute lockout), identical generic error for
  unknown-email/wrong-password/locked-account (no enumeration).
- **RBAC**: `PlatformPermission`/`MerchantPermission` maps
  (`apps/api/src/auth/permissions.ts`) - single source of truth for
  role-to-permission mapping, exercised by `access-control.e2e.test.ts`'s
  negative-case sweep.
- **Session/JWT security**: `httpOnly`/`sameSite`/`secure` cookies,
  refresh-token rotation with reuse detection (a presented, already-revoked
  refresh token is rejected, not silently accepted), HS256 with issuer/
  audience checks. `auth-token-forgery.e2e.test.ts` covers forged/tampered
  tokens.
- **Webhook authentication (inbound trust)**: HMAC-SHA256 with the
  timestamp inside the signed payload and a replay window
  (`WEBHOOK_REPLAY_WINDOW_SECONDS`) - a captured, replayed webhook
  delivery is rejected past the window.
- **Rate limiting**: per-route limits (`RateLimitGuard`, ADR 0011),
  distinct budgets for auth vs. general API vs. invoice creation.
- **Input validation**: `class-validator` DTOs on every write endpoint
  reviewed; no string-concatenated SQL found anywhere in the codebase -
  every raw query uses `Prisma.sql`/tagged-template parameterisation or
  fixed literals (the two exceptions, `provision-app-role.ts`'s role-name/
  password interpolation, take only deployment configuration, never
  request-derived input, and are documented as such at the call site).
- **Secret management**: `SecretsProvider` seam (ADR 0012), centralized
  log redaction (`redact()`, applied before every audit-log write),
  `validateProductionConfig` refusing placeholder/weak secrets and unsafe
  CORS at boot.
- **Encryption**: AES-256-GCM with a random 96-bit IV per message
  (`packages/security`), used for MFA secrets and signing key material at
  rest.
- **Docker security**: non-root user, `tini` init, multi-stage builds,
  `.dockerignore` (ADR 0021).
- **Network isolation**: Kubernetes `NetworkPolicy` scoping Pod-to-Pod
  traffic (ADR 0024).
- **Production configuration**: `validateProductionConfig` across all
  three Node services (ADR 0025), now also the least-privilege database
  role's provisioning path (this pass).
- **Privilege escalation**: `MerchantPermission.MEMBERS_MANAGE` is
  OWNER-only specifically so an ADMIN member can never engineer their own
  promotion or lock the owner out (`permissions.ts`'s own comment,
  verified against `members.service.ts`).
- **IDOR/resource authorization**: every ownership check found uses
  `findFirst({ id, merchantId })`, not just a header/session check -
  `access-control.e2e.test.ts`'s "resource-ID confusion" cases prove a
  same-merchant header with a foreign resource id still 404s.
- **Replay attacks**: webhook HMAC replay window (above); idempotency keys
  required on invoice creation (`IdempotencyService`) prevent a replayed
  client request from creating a duplicate invoice.
- **Duplicate payment handling**: `(merchantId, orderId)` unique
  constraint plus a pre-check for the common case; underpayment/overpayment
  policies are configurable and tested.
- **Blockchain reorg attacks**: per-network `reorgDepth`
  (`packages/shared/src/domain/network.ts`) drives confirmation
  recomputation for blocks within that depth of the tip -
  `apps/blockchain-monitor`'s scanner re-evaluates them rather than
  trusting a one-time confirmation count.
- **Transaction race conditions**: `FOR UPDATE SKIP LOCKED` for
  address-pool assignment plus Read Committed (not Serializable) for that
  specific transaction, with the reasoning for why Read Committed is
  correct there documented in `invoices.service.ts` itself and confirmed
  by Phase 9's load testing (ADR 0015).
