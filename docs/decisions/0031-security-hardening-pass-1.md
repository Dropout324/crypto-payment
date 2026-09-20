# ADR 0031 - Security hardening pass 1: dependency remediation, API-key scope and livemode enforcement, least-privilege database role, merchant-suspension dashboard revocation, threat model and findings register

Status: Accepted
Date: 2026-09-13

## Context

Phase 17 pass 1 (C7, `README.md#roadmap`) is the M1-gating
security review: "a security review from an enterprise customer's perspective,
every finding recorded, nothing hidden, and the release surface clean before
any assessment - internal or external - is run." Six starting gaps were
named in the roadmap (dated 2026-09-11): 1 critical + 9 high production
dependency advisories rooted in Fastify/`@nestjs/platform-fastify`;
`ApiKey.scopes` stored but never enforced; `ApiKey.livemode` not checked
against the network a request names; no least-privilege database role;
access tokens valid until TTL after a merchant is suspended; no formal
threat model.

Every gap was re-verified against the current codebase before being trusted,
per Rule 1 (evidence over claims) - re-verification found the dependency
count exactly matched (17 advisories, 1 critical, 9 high), confirmed the
other four gaps were real by reading the implicated code directly, and
additionally found one gap the roadmap's list did not name: the audit-log
listing endpoint's default ordering, previously misdiagnosed across two
prior ADRs as a flaky "write race."

## Decisions

### Dependency remediation: upgrade, not patch-around

`@nestjs/common`/`core`/`platform-fastify`/`testing` moved 10.4.15 → 11.2.3 -
the first Nest v11 patch release past `@nestjs/platform-fastify@11.1.23`
(the last version vulnerable to the "Middleware Bypass on Fastify via
Trailing Slash" advisory), and, more importantly, past the point where Nest
stopped bundling `@fastify/middie` as a dependency at all. That one change
alone removed the critical advisory (`@fastify/middie` middleware
authentication bypass in child plugin scopes) and 4 of the 9 high advisories
outright, rather than requiring a version override to patch a dependency
Nest no longer needs. `@fastify/cookie`/`cors`/`helmet` moved to their
Fastify-5-compatible majors (11.1.2/11.3.0/13.1.1) - the previous versions
targeted Fastify 4.x and failed to boot under Fastify 5 at all
(`@fastify/helmet: expected '4.x' fastify version, '5.12.4' is installed`),
caught by `test/security/http-hardening.e2e.test.ts` actually failing to
start, not by version-range inspection. Root `package.json` gained
`pnpm.overrides` for `deepmerge-ts` (→ `^8.0.2`, a high-severity
stack-exhaustion advisory reached via `prisma`'s own config loader) and
`fastify` (→ `^5.12.4`, closing the last 2 moderate advisories in the copy
`@nestjs/platform-fastify` still bundles internally at 5.11.3). A full
NestJS v12 upgrade was deliberately not taken - v11.2.3 already satisfies
every advisory's patched-version threshold, and a major-version jump this
phase does not need is exactly the kind of unforced churn Rule 8 (no
rewrites without a measurable reason) warns against.

`scripts/security/audit-report.mjs` and `.github/workflows/ci.yml`'s
`vulnerability-scan` job both flip from informational (`continue-on-error:
true`, always exit 0) to a real gate now that the count they were built to
report has reached zero - both had a comment pointing at this exact moment
as when that flip should happen, written when the job was first added
(Phase 15, ADR 0028).

### API-key scopes: enforced end-to-end, not removed

`ApiKeyScopeGuard` + `@RequireScope(...)` (`apps/api/src/auth/api-key-scope.guard.ts`)
mirror `MerchantRoleGuard`/`PlatformRoleGuard`'s existing `Reflector` +
`SetMetadata` pattern exactly, rather than inventing a new authorization
primitive. Applied to every controller behind `ApiKeyGuard`: invoices
(`invoices:read`/`invoices:write`), addresses
(`addresses:read`/`addresses:write`), transactions/merchant-transactions
(`transactions:read`), balance (`balance:read`), webhook test
(`webhooks:write`). `CreateApiKeyDto.scopes` now validates against a fixed
allowlist (`ALL_API_KEY_SCOPES`) via `@IsIn`; omitting `scopes` still grants
every scope, preserving existing integration behaviour rather than silently
locking out a key nobody thought to scope. The "or remove scopes from the
API surface" alternative the roadmap's exit criterion allowed was not
needed - full enforcement was the more valuable outcome and cost no more to
build.

### Test/live key and network separation: one shared assertion, two call sites

`assertNetworkMatchesLivemode` (`packages/shared/src/domain/network.ts`)
compares `ApiKey.livemode` against `NetworkConfig.isTestnet` - a field that
already existed on every network's config and was simply never consulted
for this purpose. Called from `invoices.service.ts::createInvoice` and
`addresses.service.ts::register`, immediately after network validation and
before any other work, so a mismatched request never reaches the exchange
rate lookup or the address pool. Investigated whether
`apps/blockchain-monitor` needed a parallel check (the roadmap's gap
description named it explicitly): it does not - the monitor has no concept
of API keys, only of `network` columns on rows it already trusts, and once
creation-time enforcement guarantees every such row's network matches the
key that created it, there is no remaining path for an inconsistency to
reach the monitor in the first place.

### Least-privilege database role: `gateway_app`, provisioned by the migration job

`packages/database/prisma/provision-app-role.ts` creates and grants
`gateway_app` - `LOGIN` only, `NOSUPERUSER NOCREATEDB NOCREATEROLE
NOREPLICATION`, `SELECT/INSERT/UPDATE/DELETE` on tables and `USAGE/SELECT`
on sequences, with `ALTER DEFAULT PRIVILEGES FOR ROLE CURRENT_USER` so a
future migration's new tables are covered without re-running this script by
hand. Written against `@prisma/client`'s `$executeRawUnsafe` rather than
adding a `pg` dependency - schema-mapped model methods are irrelevant to
role/grant DDL, but raw SQL over an existing `PrismaClient` connection works
identically, the same technique `runInTransaction`'s advisory-lock helper
already relies on.

`infrastructure/kubernetes/migration-job.yaml` runs it immediately after
`prisma migrate deploy`, using a new `DATABASE_MIGRATE_URL` secret key (the
superuser connection - migrations and role provisioning only). The
`DATABASE_URL` key `api`/`worker`/`monitor` actually consume via
`envFrom`/`secretRef` now points at `gateway_app` instead of `gateway`. This
is deliberately re-run on every deploy, not once: the same idempotent script
that grants a newly-migrated table's privileges to `gateway_app` also
back-fills grants for any table that existed before the role did, with no
separate "one-time setup" step to remember. `gateway` remains a superuser
only for migrations and PITR streaming replication (ADR 0029's own
requirement for that role) - never injected into a runtime service pod.

**Scope boundary, deliberate**: local development and the test suite still
connect as the migration role directly. `TEST_DATABASE_URL` needs to run
`prisma migrate deploy`, which requires DDL rights `gateway_app` must never
have - giving every local workflow a second, least-privilege connection
string to switch between was judged not worth the friction for a baseline
this project already documents as "development convenience," not
production-representative (Phase 10's own boundary). The finding this ADR
closes is specifically "does the production application connection run as
a superuser" - it now does not, proven by `packages/database/test/least-privilege-role.test.ts`
running against the real (if local) Postgres the test suite already uses.

### Merchant suspension revokes dashboard access immediately

`MerchantRoleGuard` (`apps/api/src/auth/merchant-role.guard.ts`) already ran
a database query for the `MerchantMember` row on every request; that query
now also selects `merchant.status` and rejects with 403 if it is not
`ACTIVE`. This closes a gap larger than the roadmap's own framing
suggested: `ApiKeyGuard` already re-checked `merchant.status` (a real DB
lookup, not a JWT claim) before this pass, so API-key traffic from a
suspended merchant was never the actual exposure. The dashboard path was -
a suspended merchant's logged-in team kept full dashboard access for as
long as they stayed logged in, not merely for one access-token TTL, because
nothing on that path ever looked at `merchant.status` at all.

### Post-suspension token validity: mitigated where it mattered, accepted and bounded where it does not yet apply

Recorded decision, as the roadmap requires:

- **Merchant-level suspension** (the gap that actually exists as a live
  feature today, via `POST /v1/admin/merchants/:id/suspend`): **mitigated**,
  above - no TTL window at all, verified by
  `access-control.e2e.test.ts`'s new "dashboard access after merchant
  suspension" cases.
- **User-level suspension** (no API endpoint suspends an individual `User`
  directly today - this is a forward-looking bound, not a mitigation of a
  live gap): **accepted**, bounded to `JWT_ACCESS_TTL_SECONDS` (default 900s
  / 15 minutes). `JwtAuthGuard` is deliberately stateless (no DB lookup per
  dashboard request, by explicit design - see its own doc comment); making
  it stateful to close a currently-unreachable gap would trade a real,
  permanent latency cost for a hypothetical one. `AuthService.refresh`
  already re-validates `user.status` on every refresh, so the exposure
  cannot extend past one access-token lifetime regardless. Already
  exercised by an existing test
  (`auth-token-forgery.e2e.test.ts`, "a still-valid access token keeps
  working for a few minutes after the account is suspended") whose own
  comment independently states the same bound and rationale this ADR
  records - this pass did not need to add that test, only confirm it still
  reflects reality and formalize the decision it documents.

### Audit log listing: newest-first, not a "write race"

Found during this pass's own review of the audit-logging area (explicitly
in Phase 17 pass 1's scope), not one of the roadmap's six named gaps.
`admin-audit-logs.e2e.test.ts`'s first case has failed since Phase 11 (ADR
0025) and was re-confirmed still failing in Phase 16 (ADR 0030), both times
attributed to "a plausible audit-log-write race" and left open. Re-investigated
here: `AdminAuditLogsService.list` ordered `id: asc` (oldest first) with
standard cursor pagination - correct for `pagination.ts`'s documented
convention on an owner-scoped resource list, wrong for this endpoint, whose
rows accumulate globally and without bound. Counting rows directly in the
shared local test database found 47 pre-existing `merchant.suspended`
audit rows (from the many prior runs `gateway_test` never resets between,
ADR 0020) - more than `DEFAULT_PAGE_LIMIT`'s 20 - all sorted ahead of the
row the test had just written. Nothing was racing. Flipped to `id: desc`
with a matching `lt` cursor: an operator (or a test) querying for a
specific recent action now sees it first, matching how incident-response
tooling conventionally orders audit trails. `admin-audit-logs.e2e.test.ts`'s
previously-failing case now passes with no change to the test or to the
still-unreset shared database - the fix, not a change in test conditions,
is what closed it.

### Threat model and findings register

`docs/security/threat-model.md`: assets, actors/trust boundaries, attack
surface by entry point, and what this pass (and Phase 17 pass 2, later)
changes about each. `docs/security/findings-register.md`: every area in
Phase 17 pass 1's scope, each finding's severity, impact, exploit scenario,
mitigation and implementation status - including the areas reviewed that
produced no new finding, so the register is a record of what was actually
checked, not only of what was broken.

## Evidence

**Dependency remediation** - `pnpm audit --prod --json`, before: `1
critical, 9 high` (17 total across all severities, matching the roadmap's
stated count exactly); after: `{"info":0,"low":0,"moderate":0,"high":0,"critical":0}`.
`pnpm --filter @gateway/api typecheck` and `build` both clean after the
upgrade. `pnpm audit:report` (the CI script) exits 0 with "Zero
critical/high advisories" after the fix, and was verified to set
`process.exitCode = 1` on a nonzero count by reading the modified logic
(the fixed state itself cannot demonstrate the failure path without
reintroducing a real advisory).

**API-key scopes** - `apps/api/test/security/api-key-scopes.e2e.test.ts`
(7 tests, all passing): an under-scoped key rejected with 403 naming the
missing scope; a correctly-scoped key succeeds; the dashboard create-key
endpoint defaults to full access when `scopes` is omitted and rejects an
unrecognised scope string with 400. A pre-existing test
(`input-and-data-exposure.e2e.test.ts`) that explicitly asserted the old,
unenforced behaviour under the title "KNOWN GAP: ... scopes are stored and
returned but never checked by any guard" now asserts and passes against the
fixed (403) behaviour, renamed to record the fix.

**Test/live key and network separation** -
`apps/api/test/security/livemode-network-separation.e2e.test.ts` (6 tests,
all passing): both mismatch directions (test key vs. mainnet, live key vs.
testnet), both endpoints (invoice creation, address registration), and both
matching-direction positive cases.

**Least-privilege database role** -
`packages/database/test/least-privilege-role.test.ts` (6 tests, all
passing, against real Postgres): `gateway_app` can SELECT/INSERT/UPDATE/DELETE
on an existing table; `CREATE TABLE`, `ALTER TABLE`, `DROP TABLE`, and
`ALTER ROLE ... WITH SUPERUSER` all reject with a real Postgres
permission-denied/must-be-owner error; a table created *after* provisioning
still grants `gateway_app` access automatically (`ALTER DEFAULT PRIVILEGES`
proven to actually work, not just declared).

**Merchant suspension** -
`apps/api/test/security/access-control.e2e.test.ts`'s new "dashboard access
after merchant suspension" cases (2 tests, both passing): a session that
worked before suspension is rejected with 403 on the very next request
after suspension with no re-login involved, and access is restored on
reactivation.

**Audit log ordering** - `admin-audit-logs.e2e.test.ts`'s previously-failing
case passes after the fix; row count directly queried from the shared test
database (47 pre-existing matching rows) confirms the root cause before
attributing the fix to it.

**Full regression run** - `pnpm --filter @gateway/api test` (the complete
suite, 30 files) after every change in this ADR: 179 tests, 179 passing, 0
failing. `pnpm --filter @gateway/database test` (32 tests, including the 6
new least-privilege-role tests): all passing. `pnpm --filter @gateway/shared
test` (89 tests, covering the new `assertNetworkMatchesLivemode` via the
existing domain test suite's network/asset fixtures): all passing.

## Consequences

- **Zero unresolved critical or high production dependency advisories** -
  the M1 gate's exit criterion holds without risk acceptance, and the CI
  gate that reports this can no longer regress silently.
- **A key or a service that was implicitly "trust everything past
  authentication" is now scoped on three independent dimensions**: RBAC
  role (pre-existing), API-key scope, and livemode/network match (both
  new). Existing integrations that never set `scopes` are unaffected (full
  access by default); one that did set a narrow `scopes` list and was
  silently over-privileged as a result now gets exactly what it asked for.
- **A compromised or buggy application process can no longer alter schema
  or escalate privilege at the database level** - the blast radius of any
  future SQL-injection-class bug or dependency compromise is now bounded to
  the rows `gateway_app` can already read/write, not the entire cluster.
- **Not done, disclosed**: the SSRF guard's DNS-rebinding TOCTOU gap
  (documented in `ssrf-guard.ts` since before this phase, re-confirmed
  still present, carried forward in the findings register) - closing it
  requires pinning the resolved address for the actual outbound connection,
  a larger change than this pass's required exit criteria call for.
  User-level post-suspension token exposure remains an accepted, bounded
  risk rather than a mitigated one, per the recorded decision above -
  revisit if/when user-level suspension becomes a live feature.
- **Phase 17 pass 2** (Tier 2 feature attack surface: Phases 12, 13, 25, 26,
  27, plus a re-run of this pass's checks on the release candidate) is
  unchanged in scope by this ADR - none of Phase 17 pass 2's named phases
  were touched here.
