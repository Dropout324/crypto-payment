# Threat model

Status: living document, first written Phase 17 pass 1 (ADR 0031)
Date: 2026-09-13

## Purpose

A brief model of who can attack this system, through which surfaces, and
what stops them - written from an enterprise customer's security-review
perspective, to be read alongside `docs/security/findings-register.md`
(the concrete findings this model motivated) and revisited whenever a new
phase changes the attack surface (Phase 17 pass 2 covers the Tier 2 feature
surface: Phases 12, 13, 25, 26, 27).

## Assets

Ranked by what an attacker would actually want, or what loss would hurt most:

1. **Custody of funds in transit** - a deposit address, once assigned, is
   the one thing standing between a customer's payment and the merchant's
   ledger credit. The gateway itself never holds private keys for deposit
   addresses (Mode B - merchant-supplied addresses, ADR 0002); Mode A
   (custodial signing) exists as an architecture (`packages/signing`, ADR
   0013/0026) but is not live, so there is currently no gateway-controlled
   key material an attacker could steal to move funds directly.
2. **The ledger's integrity** - `ledger_accounts`/`ledger_entries` are the
   system of record for what every merchant is owed. A double-credit, a
   silently "corrected" discrepancy, or a non-append-only mutation is a
   direct financial loss, not just a data-quality bug (Rule 5, roadmap).
3. **Merchant API keys and webhook secrets** - a stolen live key can create
   invoices, read balances and transaction history, and (if scoped for it)
   register deposit addresses under the merchant's name; a stolen webhook
   secret lets an attacker forge events the merchant's system trusts.
4. **Merchant and customer PII** - email addresses, IP addresses, user
   agents; lower sensitivity than the above, but still a real breach if
   exposed via logs or an IDOR.
5. **Platform-admin credentials** - a compromised `ADMIN` platform role can
   suspend merchants, resolve reconciliation discrepancies (potentially
   masking a real one), and approve/reject refunds.

## Actors and trust boundaries

| Actor | Trust level | Reaches |
|---|---|---|
| Anonymous internet | Untrusted | `POST /v1/auth/login`, the hosted public invoice page, webhook endpoint URLs the gateway calls out to (reverse direction) |
| Customer paying an invoice | Untrusted, but the invoice/address themselves are not secret | Public invoice page, the blockchain directly (sends a real transaction) |
| Merchant integration (API key holder) | Semi-trusted, scoped by `ApiKey.scopes` and `livemode` (Phase 17 pass 1) | `v1/payment-invoices`, `v1/merchant/addresses`, `v1/merchant/balance`, `v1/merchant/transactions`, `v1/transactions`, `v1/webhooks/test` |
| Merchant dashboard user (JWT session) | Semi-trusted, scoped by `MerchantMember.role` via `MerchantRoleGuard` | `v1/merchant/me/*` |
| Platform operator (ADMIN/SUPPORT/COMPLIANCE_OFFICER) | Trusted, scoped by `platformRole` via `PlatformRoleGuard` | `v1/admin/*` |
| Merchant's own webhook receiver | Trusted by the merchant, not by the gateway | Receives signed events; the gateway does not trust anything it sends back |
| Blockchain RPC providers | Trusted for data, not for availability (failover configured) | Read-only source of truth for on-chain state |
| Postgres | Trusted, but now least-privilege for the application (Phase 17 pass 1, ADR 0031) | Every service via `@gateway/database` |

The most important boundary this model tracks is **API key scope and
livemode**, because it is the newest one: before Phase 17 pass 1, an
authenticated-but-under-privileged merchant integration (a "read-only"
integration key, or a test-mode key) was trusted exactly as much as a
full-access live key once past `ApiKeyGuard` - the boundary existed on
paper (`scopes`, `livemode` columns) but nothing enforced it.

## Attack surface, by entry point

- **Public HTTP API** (`apps/api`): the largest surface. Every endpoint
  behind `ApiKeyGuard`, `JwtAuthGuard`, `MerchantRoleGuard`,
  `PlatformRoleGuard`, or (new) `ApiKeyScopeGuard` is a place an
  authorization bug turns into unauthorized data access or a privileged
  write. `access-control.e2e.test.ts` and the other `test/security/*`
  suites are the regression backstop for this surface.
- **Public invoice page / unauthenticated read paths**: `GET
  /v1/public/invoices/:id` - the id itself is the only credential; it is a
  ULID, not sequentially guessable, but is not treated as a secret (it
  appears in URLs, QR codes, and merchant redirect flows by design).
- **Webhook delivery (outbound)**: `packages/webhooks` sends signed HTTP
  requests to merchant-controlled URLs. `ssrf-guard.ts` is the boundary
  stopping a malicious/compromised merchant from using the gateway as a
  private-network proxy. See the SSRF finding in the register for its one
  documented gap (DNS-rebinding TOCTOU).
- **Blockchain ingestion (inbound, from the gateway's perspective)**:
  `apps/blockchain-monitor` treats every RPC response as attacker-reachable
  data in the sense that a reorg, a malicious/malformed transaction, or a
  chain split must never corrupt the ledger - `reorgDepth` per network
  (`packages/shared/src/domain/network.ts`) and confirmation-based crediting
  are the controls.
- **Database**: every service's Prisma connection. Phase 17 pass 1 removed
  the previous "every service is effectively a Postgres superuser" boundary
  (ADR 0031) - see the database-permissions finding.
- **Container/orchestration layer**: `infrastructure/kubernetes/` -
  non-root containers, `NetworkPolicy`-scoped Pod-to-Pod traffic (ADR 0024),
  Secrets separate from ConfigMaps.
- **Supply chain**: `pnpm-lock.yaml`'s full dependency tree. `pnpm audit
  --prod` (`scripts/security/audit-report.mjs`) is the automated check;
  Phase 17 pass 1 is the first time its output was zero across every
  severity.

## What this pass changed about the model

- API keys are no longer binary "authenticated or not" - `scopes` and
  `livemode` are now real trust-boundary dimensions the guards enforce
  (`ApiKeyScopeGuard`, `assertNetworkMatchesLivemode`).
- The application's database connection is no longer equivalent to a
  Postgres superuser - a compromised application process (a bug, an
  injected raw query, a dependency compromise) can read/write existing
  rows but cannot alter schema, escalate its own role, or touch objects
  outside the grants `gateway_app` holds.
- A suspended merchant's dashboard session is no longer trusted for the
  remainder of its access-token lifetime - `MerchantRoleGuard` re-checks
  `merchant.status` on every request.

## What this pass did not change (explicitly out of scope)

- **Mode A (custodial signing) is not live.** The signing policy engine
  (`packages/signing`) and its threat surface (key material handling,
  approval workflow abuse) exist as architecture and are exercised by unit
  tests, but there is no real KMS/HSM backend wired in - see ADR 0026.
  `validateProductionConfig` refuses to boot with `SIGNING_BACKEND` set to
  anything but `disabled` in production, closing the one path that could
  accidentally expose this surface before it is ready.
- **Compliance/sanctions screening is not integrated** (`COMPLIANCE_PROVIDER=none`).
  The review-threshold and hold workflow exist; no real screening provider
  is connected.
- **Bitcoin support**: the adapter exists (Phase 13, ADR 0027) and is
  tested, but is a separate trust boundary (a different signature scheme,
  a different reorg model) this document does not repeat in detail - see
  ADR 0027 directly.
- **Tier 2 feature attack surface** (Phases 12, 13, 25, 26, 27): explicitly
  Phase 17 pass 2's scope, run before Phase 30, per the roadmap's execution
  waves. This pass only re-affirms the boundaries above for the surface
  that exists today.
- **The DNS-rebinding TOCTOU gap in the SSRF guard** (see findings
  register): known, documented, not closed this pass - closing it requires
  pinning the resolved address for the actual outbound connection, which
  is worth doing before this system handles untrusted production webhook
  traffic at scale, but was not one of this pass's required exit criteria.
