# Crypto Payment Gateway

A cryptocurrency payment gateway for merchants: create an invoice, receive a
payment destination, detect the on-chain transaction, wait for confirmations,
record it in a double-entry ledger, and notify the merchant by signed webhook.

Built for correctness and auditability first. Every design choice that trades
convenience for financial safety is documented in [`docs/decisions/`](docs/decisions/).

> **Status: Phases 1-6 and 9 complete, Phase 3/4's EVM adapter now live (633
> tests, 14 packages/apps). Phase 9.5 (Kubernetes prerequisites) is done, and
> Phase 10 (Kubernetes baseline, monitoring baseline, backup/DR baseline,
> CI/CD baseline) is now done too - see [Roadmap](#roadmap) for exactly what
> "baseline" means and what evidence backs each part; production-depth work
> (config validation, TLS, full CI gates, measured RPO/RTO) is Phases
> 11/14/15; financial metrics, alert rules, a dashboard specification, an
> operations runbook and an incident-response procedure (Phase 16) are now
> done too - see the Roadmap table.**
> `apps/api` (NestJS + Fastify) serves invoice creation,
> retrieval, status and cancellation behind API-key auth, with idempotency,
> lazy expiry, and a merchant deposit-address pool for Mode B (see
> [ADR 0006](docs/decisions/0006-merchant-address-pool.md)). `apps/blockchain-monitor`
> runs the full detection → matching → confirmation → settlement → ledger
> pipeline end-to-end - proven against `FakeBlockchainAdapter` AND, now, a
> real `EvmJsonRpcAdapter` verified live and running concurrently across all
> six configured EVM networks (Ethereum, Polygon, BSC and their testnets; see
> [ADR 0010](docs/decisions/0010-evm-rpc-adapter-and-chain-scanner.md)) -
> including underpayment/overpayment policy handling and reorg recovery (see
> [ADR 0007](docs/decisions/0007-monitor-single-primary-tx-model.md) and
> [ADR 0008](docs/decisions/0008-reorg-never-reverses-a-credit.md)). The
> double-entry ledger (`packages/ledger`) posts balanced, idempotent credits
> and reconciles cached balances against ground truth without ever
> auto-correcting a mismatch. `apps/worker` runs signed, retried webhook
> delivery (`packages/webhooks`; see [ADR 0009](docs/decisions/0009-webhook-delivery-design.md))
> plus a proactive invoice-expiry sweep. **Phase 7's backend is now largely
> in place**: merchant self-service endpoints (balance, transaction history,
> invoice list, API key management, webhook endpoint management, settings)
> and admin endpoints (merchant management, compliance checks, reconciliation
> discrepancies, refunds, settlements) all exist behind session auth
> (`v1/auth`), plus the standalone `GET /v1/transactions/:hash` and
> `POST /v1/webhooks/test` that were previously missing. **The dashboard
> frontend now exists** (`apps/web`, Next.js App Router): cookie-based
> session auth (login/logout, `middleware`-level route gating, per-request
> re-verification via `GET /v1/auth/me`), a merchant dashboard (balance,
> invoices, transactions, API keys, webhook endpoints, settings - all
> read-only so far, no create/rotate/revoke/approve forms yet) and an admin
> dashboard (merchants, compliance, reconciliation, refunds, settlements),
> both gated by the same guards the API enforces (`MerchantRoleGuard` /
> `PlatformRoleGuard`). The hosted **payment page** (`/pay/[invoiceId]`) now
> renders real data too, backed by the new unauthenticated
> `GET /v1/public/invoices/:id` (own controller, no `ApiKeyGuard`/
> `JwtAuthGuard` - see [API](#api)), and polls it while the payer waits so
> confirmations update without a manual refresh. **A Bitcoin adapter now
> exists too** (`BitcoinRpcAdapter`, UTXO rather than account-based - ADR
> 0027), proven end to end against a real Bitcoin Core regtest node
> (payment detection, confirmations, a real reorg, and a duplicate-transaction
> case); mainnet evidence is separate, later work. **Every merchant and
> operator write action now works from the dashboard, not just the API**
> (Phase 18): merchants can create/revoke API keys, manage webhook endpoints
> and rotate their secrets, and add/change the role of/remove team members
> from a new "Team" page; operators can review compliance checks,
> suspend/reactivate merchants, resolve reconciliation discrepancies,
> approve/reject refunds, and browse a new filterable audit-log page. Every
> role check shown in the UI is independently re-enforced by the API
> regardless of what the client sends, proven by E2E tests that call the raw
> API directly as an under-privileged role and confirm a `403`. See
> [Roadmap](#roadmap).

---

## Principles

These are enforced by code and tests, not by convention:

1. **The blockchain is the source of truth for payments.** Client state,
   merchant callbacks and WebSocket events are all re-verified against chain
   state before anything is credited.
2. **No floating point in money.** Every amount is a `bigint` of the asset's
   smallest unit, stored as `NUMERIC(78,0)`. See [ADR 0001](docs/decisions/0001-money-representation.md).
3. **One credit per transfer, forever.** `UNIQUE (network, tx_hash, transfer_index)`
   makes double-crediting impossible even if a worker reprocesses a block.
4. **The ledger balances or the transaction does not commit.** A deferred
   constraint trigger sums debits and credits per asset at COMMIT.
5. **Financial history is append-only.** `UPDATE` and `DELETE` on ledger
   entries, payment events and audit logs are rejected by the database.
6. **Money is never unaccounted for.** Late payments, unsupported assets,
   underpayments and reorg-orphaned credits all land in a review queue.
7. **The application never holds private keys.** Signing is delegated to a
   policy-enforcing service backed by a KMS/HSM.
8. **Secrets are never logged.** Redaction is centralised, not left to call sites.

## Supported assets

The gateway credits only assets on an explicit allowlist
([`packages/shared/src/domain/asset.ts`](packages/shared/src/domain/asset.ts)),
matched by **contract address**, never by symbol.

| Network | Native | Tokens |
|---|---|---|
| Bitcoin[^btc] | BTC | - |
| Ethereum | ETH | USDT (6 dp), USDC (6 dp) |
| Polygon | POL | USDT (6 dp), USDC (6 dp) |
| BNB Smart Chain | BNB | USDT (**18 dp**), USDC (**18 dp**) |

Adding a standard ERC-20/BEP-20 on a supported network is a registry entry, not
a code change. Adding a network requires a new `BlockchainAdapter`. Assets with
fee-on-transfer or rebasing semantics, and assets with no reliable price feed,
are deliberately excluded.

[^btc]: Implemented and tested end to end (`BitcoinRpcAdapter`, ADR 0027) -
    proven against a real Bitcoin Core regtest node, not yet validated on
    Bitcoin mainnet/testnet with real funds (that evidence is Phase 24/31's
    job, tracked separately from EVM's).

---

## Getting started

### Requirements

- Node.js 22+
- pnpm 10+
- PostgreSQL 17+ and Redis 7+ (via Docker, or see [without Docker](#without-docker))

### With Docker (recommended)

```bash
git clone <repo> && cd crypto-pga
pnpm install

cp .env.example .env          # then fill in the secrets it lists
docker compose up -d postgres redis

pnpm db:generate
pnpm db:migrate:deploy
pnpm seed                     # prints test credentials once
```

### Without Docker

`scripts/dev-postgres.ps1` runs a real PostgreSQL server from a conda
environment. See [ADR 0003](docs/decisions/0003-local-database.md).

```powershell
conda create -y -n cpga-pg -c conda-forge postgresql
.\scripts\dev-postgres.ps1 init      # initdb + create gateway/gateway_test
.\scripts\dev-postgres.ps1 start
```

Then set in `.env`:

```
DATABASE_URL=postgresql://postgres@127.0.0.1:5432/gateway?schema=public
TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:5432/gateway_test?schema=public
```

### Verify

```bash
pnpm build             # compile every package
pnpm test:db:migrate   # apply migrations to TEST_DATABASE_URL (once, or after a new migration)
pnpm test              # unit + integration suites - runs against gateway_test, never gateway
```

Integration tests require a live database and **fail** rather than skip when one
is missing — a green suite that tested nothing is worse than a red one. Every
integration suite resolves its own database from `TEST_DATABASE_URL`, never
`DATABASE_URL` - see [ADR 0020](docs/decisions/0020-test-database-isolation.md).

---

## Project structure

```
apps/
  api/                  REST API - NestJS + Fastify (invoices, addresses, health/ready,
                         /metrics on its own port, graceful shutdown - ADR 0019)
  worker/               webhook delivery loop + proactive invoice-expiry sweep (Phase 6);
                         ledger reconciliation runs on a schedule + financial-health gauges
                         (Phase 16, ADR 0030); own /health,/ready,/metrics listener
                         (ADR 0019, Phase 9.5); settlement scheduling still to come (Phase 25)
  blockchain-monitor/   detection (ChainScanner + EvmJsonRpcAdapter), matching,
                         confirmations, reorg, ledger posting; own /health,/ready,/metrics
                         listener including per-network scan lag (ADR 0019, Phase 9.5)
  web/                  merchant + admin dashboard + hosted payment page (Next.js App
                         Router, Phase 7 - dashboards read-only so far, no write forms);
                         /health route + /metrics (own port) in the production server.js
                         (ADR 0019, Phase 9.5); e2e/ - Playwright browser E2E suite
                         (Phase 9, ADR 0017)

packages/
  shared/           money (bigint), IDs, errors, asset + network registries
  database/         Prisma schema, migrations, chart of accounts, seed
  security/         Argon2 credentials, webhook HMAC, AES-GCM, redaction, rate
                     limiter, SecretsProvider seam (see ADR 0011, ADR 0012)
  observability/    structured JSON logging (pino, routed through @gateway/security's
                     redact()), Prometheus metrics (prom-client), request-id context,
                     the shared /health,/ready,/metrics HTTP listener (Phase 9.5, ADR 0019)
  signing/          Custodial signing policy engine - allowlist/ceilings/approvals
                     (Phase 8; see ADR 0013). No real KMS/HSM backend, not wired
                     into apps/api yet - Mode A itself is still not live
  blockchain/       BlockchainAdapter interface, EvmJsonRpcAdapter (live RPC),
                     EVM transfer parsing, Bitcoin/EVM address validation,
                     FakeBlockchainAdapter
  payments/         invoice state machine, matcher, payment evaluation, confirmations/reorg
  exchange-rate/    ExchangeRateService, CoinGecko + Binance providers
  ledger/           double-entry posting, balances, reconciliation
  webhooks/         signed delivery, insert-per-attempt retries, SSRF guard (Phase 6;
                     see ADR 0009) - consumed by apps/worker

infrastructure/
  docker/               Dockerfile (multi-target, one HEALTHCHECK per service), postgres
                         init, .dockerignore (Phase 9.5)
  kubernetes/           Phase 10 baseline manifests: namespace, ConfigMap, Secret
                         template + generator script, in-cluster Postgres/Redis, a
                         migration Job, and Deployment+Service for api/worker/monitor/web
                         - deployed and verified against a real `kind` cluster (ADR 0024).
                         kubernetes/monitoring/ - Prometheus (scrapes each service's
                         /metrics) + Grafana with one provisioned dashboard.
                         kubernetes/backup/ - a nightly backup CronJob and a restore-drill
                         Job template (ADR 0022). See scripts/kubernetes/ for the deploy,
                         secret-generation, image-build-and-load and restore-drill scripts,
                         and scripts/backup/ for the underlying pg_dump/pg_restore scripts.

docs/
  decisions/            architecture decision records
scripts/                development helpers; scripts/test/ - shared test-database
                         resolution used by every integration suite's Vitest setup
                         (ADR 0020), not a workspace package itself
```

## API

`apps/api` implements, behind `Authorization: Bearer <api_key>` (merchant
endpoints) or session auth from `v1/auth` (admin endpoints):

**Invoices & core**

| Endpoint | Notes |
|---|---|
| `POST /v1/payment-invoices` | Requires `Idempotency-Key`; prices via `@gateway/exchange-rate`, reserves a pooled address |
| `GET /v1/payment-invoices/:id` | Merchant-scoped; 404s for another merchant's invoice |
| `GET /v1/payment-invoices/:id/status` | Lazily transitions to `EXPIRED` on read if the deadline has passed |
| `POST /v1/payment-invoices/:id/cancel` | Validated by the state machine; retires (never frees) the address |
| `GET /v1/public/invoices/:id` | **Unauthenticated** - the hosted payment page's only data source. Own controller (`PublicInvoicesController`), never `ApiKeyGuard`/`JwtAuthGuard`; a strict field subset (no `callback_url`/`metadata`/`external_reference`); rate-limited by IP |
| `GET /v1/transactions/:hash` | Look up a transaction by hash |
| `POST /v1/webhooks/test` | Send a test webhook delivery |
| `GET /v1/health`, `GET /v1/ready` | Liveness vs. readiness (the latter checks the database AND Redis, since `RateLimitGuard` sits in front of nearly every route - see ADR 0019) |

**Auth**

| Endpoint | Notes |
|---|---|
| `POST /v1/auth/login`, `POST /v1/auth/refresh`, `POST /v1/auth/logout`, `GET /v1/auth/me` | Session auth for `apps/web`'s dashboards |

**Merchant self-service** (`v1/merchant/...`)

| Endpoint | Notes |
|---|---|
| `POST`/`GET /v1/merchant/addresses` | Mode B deposit address pool ([ADR 0006](docs/decisions/0006-merchant-address-pool.md)) |
| `GET /v1/merchant/balance`, `GET /v1/merchant/me/balance` | Computed via `@gateway/ledger`'s `computeAccountBalance` |
| `GET /v1/merchant/transactions`, `GET /v1/merchant/me/transactions` | Transaction history |
| `GET /v1/merchant/me/invoices` | Invoice list |
| `GET`/`POST /v1/merchant/me/api-keys`, `POST /v1/merchant/me/api-keys/:id/revoke` | API key management |
| `GET`/`POST /v1/merchant/me/webhook-endpoints`, `PATCH :id`, `POST :id/rotate-secret`, `POST :id/test` | Webhook endpoint management |
| `GET /v1/merchant/me/settings` | Merchant settings |
| `GET`/`POST /v1/merchant/me/members`, `PATCH`/`DELETE :id` | Team membership - add/role-change/remove is `OWNER`-only ([ADR 0014](docs/decisions/0014-rbac-permissions-and-membership.md)) |

**Admin** (`v1/admin/...`)

| Endpoint | Notes |
|---|---|
| `GET /v1/admin/merchants`, `GET :id`, `POST :id/suspend`, `POST :id/reactivate` | Merchant management |
| `GET /v1/admin/compliance-checks`, `POST :id/review` | Compliance review queue |
| `GET /v1/admin/reconciliation-discrepancies`, `POST :id/resolve` | Never auto-resolved - only this endpoint closes one |
| `GET /v1/admin/refunds`, `POST :id/approve`, `POST :id/reject` | Refund approval |
| `GET /v1/admin/settlements` | Settlement view |
| `GET /v1/admin/audit-logs` | Every privileged action across every resource - `COMPLIANCE_OFFICER`/`ADMIN` only, tighter than the rest of this table (ADR 0014) |

This is the full API surface the dashboards need, and `apps/web` now consumes
it for every read view listed above, including the public payment page via
`GET /v1/public/invoices/:id`.

Invoice expiry is enforced two ways: lazily on read (a `GET` past the
deadline flips `PENDING`/`UNDERPAID` to `EXPIRED` before responding) and
proactively by `apps/worker`'s sweep loop (`WORKER_EXPIRY_SWEEP_INTERVAL_MS`,
default 30s), so an invoice nobody ever reads again still expires close to
its deadline rather than staying `PENDING` forever.

`main.ts` calls `app.enableShutdownHooks()` and handles `SIGTERM`/`SIGINT`
itself (Phase 9.5): on either signal it stops accepting new connections,
waits for in-flight requests to finish (bounded by `SHUTDOWN_TIMEOUT_MS`,
default 10s), and only then closes `PrismaModule`/`RedisModule` and exits -
a rolling Kubernetes deploy does not cut off a request that was already in
progress. See [ADR 0019](docs/decisions/0019-observability.md) for the
shutdown ordering this depends on.

```bash
pnpm --filter @gateway/api dev     # run the API against DATABASE_URL from .env
```

## Blockchain monitor

`apps/blockchain-monitor`'s `MonitorService` runs the full payment pipeline
against any `BlockchainAdapter` - detection, SPEC-section-11 matching,
confirmation tracking, settlement (including merchant underpayment/
overpayment auto-accept policies), and reorg recovery. Proven against
`FakeBlockchainAdapter` (ADR 0004) and, now, `EvmJsonRpcAdapter`
(`@gateway/blockchain`) - a real EVM JSON-RPC client, verified live against
Ethereum Sepolia - see [ADR 0010](docs/decisions/0010-evm-rpc-adapter-and-chain-scanner.md).

| Method | Does |
|---|---|
| `processTransaction(adapter, network, txHash)` | Re-fetches the tx + its transfers, matches them to invoices, records everything idempotently |
| `updateConfirmations(adapter, network)` | Advances DETECTED → CONFIRMING → PAID/UNDERPAID/OVERPAID, posts the ledger credit on settlement |
| `handleReorg(network, fromBlock)` | Orphans affected transactions; reverts uncredited invoices, flags already-credited ones for `RECONCILIATION_REQUIRED` (ADR 0008) rather than reversing them |

`ChainScanner` (`src/scanner.ts`) is what decides which transactions to hand
`MonitorService` in the first place: it walks new blocks and matches
transfers against currently-tracked `payment_addresses`, persisting scan
position per network in `chain_cursors` so a restart resumes rather than
re-scanning or skipping. On an EVM adapter it uses a cheap discovery path -
one `eth_getLogs` call per tick, filtered server-side to allowlisted token
contracts and tracked addresses, plus a receipt-free block read for native
transfers - rather than fetching every transaction's receipt; the naive
per-transaction version exhausted a free RPC tier's rate limit against real
Ethereum/BSC mainnet traffic within minutes (see ADR 0010). `main.ts` starts
one scan loop per EVM network that has an RPC URL configured in `.env` -
`ETHEREUM_RPC_URL`, `ETHEREUM_SEPOLIA_RPC_URL`, `POLYGON_RPC_URL`,
`BSC_RPC_URL`, etc.; leave one empty to leave that network unwatched.
Bitcoin (`BitcoinRpcAdapter`, ADR 0027) uses this same generic scan path
unmodified - no separate EVM-style fast-discovery method was needed; its
`getBlock` fetches transaction hashes only (`getblock` verbosity 1, not the
fully-decoded verbosity 2), which is already all this generic path reads
before separately confirming a real candidate via `getTransaction`/
`getTransfers`. `main.ts` starts one scan loop per Bitcoin network with an
RPC URL configured (`BITCOIN_RPC_URL`, `BITCOIN_TESTNET_RPC_URL`), same as
the EVM ones.

```bash
pnpm --filter @gateway/blockchain-monitor test   # fake adapter + ChainScanner, against a live database;
                                                  # also runs real-regtest Bitcoin tests if BITCOIN_REGTEST_RPC_URL is set
pnpm --filter @gateway/blockchain test           # includes EvmJsonRpcAdapter unit tests, plus a live
                                                  # Sepolia smoke test that skips if no RPC URL is set, and
                                                  # BitcoinRpcAdapter tests against a local regtest node
pnpm --filter @gateway/blockchain-monitor dev    # run the real scan loop(s) against DATABASE_URL + configured RPC URLs
docker compose --profile bitcoin up -d bitcoind-regtest  # local Bitcoin regtest node for the tests above
```

## Worker (webhooks + expiry sweep)

`apps/worker` runs two independent poll loops against the same database:

| Loop | Interval | Does |
|---|---|---|
| Webhook dispatch (`@gateway/webhooks`) | `WORKER_WEBHOOK_POLL_INTERVAL_MS` | Fans out undelivered `webhook_events` to enabled, subscribed endpoints; sends signed, timestamped POSTs; retries with backoff; auto-disables an endpoint after too many consecutive failures; recovers deliveries a crashed worker left `IN_FLIGHT` |
| Expiry sweep | `WORKER_EXPIRY_SWEEP_INTERVAL_MS` | Proactively expires `PENDING`/`UNDERPAID` invoices past their deadline |

Every delivery attempt is its own `webhook_deliveries` row - see
[ADR 0009](docs/decisions/0009-webhook-delivery-design.md) for why retries are
inserts rather than updates, why the HTTP call never runs inside a database
transaction, and how the SSRF guard (`WEBHOOK_BLOCK_PRIVATE_NETWORKS`) treats
a merchant-supplied endpoint URL as untrusted input.

```bash
pnpm --filter @gateway/worker dev    # run both loops against DATABASE_URL from .env
pnpm --filter @gateway/webhooks test # dispatcher + SSRF guard, against a live database
pnpm --filter @gateway/worker test   # expiry sweep, against a live database
```

## Rate limiting

`RateLimitGuard` (`apps/api/src/common/rate-limit.guard.js`) sits on every
endpoint, backed by a Redis fixed-window counter (`@gateway/security`'s
`RateLimiter`). Three profiles, each its own bucket - see
[ADR 0011](docs/decisions/0011-rate-limiting.md) for why fixed-window, why
per-controller rather than global, and why each profile keys the way it
does:

| Profile | Config | Keyed by |
|---|---|---|
| `api` (default) | `RATE_LIMIT_API_PER_MINUTE` | API key, else session user, else IP |
| `auth` | `RATE_LIMIT_AUTH_PER_MINUTE` | IP - `POST /v1/auth/login`, `/refresh` |
| `invoiceCreate` | `RATE_LIMIT_INVOICE_CREATE_PER_MINUTE` | Merchant - `POST /v1/payment-invoices` |

A 429 always carries a `Retry-After` header. `RATE_LIMIT_TRUST_PROXY`
controls whether `request.ip` (used both here and by `ApiKeyGuard`'s IP
allowlist) trusts `X-Forwarded-For` - leave it `false` unless this runs
behind a proxy that strips client-supplied forwarding headers.

```bash
pnpm --filter @gateway/security test # RateLimiter, against a live Redis (pnpm dev:infra)
pnpm --filter @gateway/api test      # includes rate-limit.e2e.test.ts, a real 429 end-to-end
```

## Observability (Phase 9.5)

`@gateway/observability` (pino + `prom-client`, wired through
`@gateway/security`'s `redact()` - see [ADR 0019](docs/decisions/0019-observability.md))
is the one logging/metrics path every service uses:

| Service | `/health`, `/ready` | `/metrics` |
|---|---|---|
| `apps/api` | `GET /v1/health`, `GET /v1/ready` (public port) | own port, `METRICS_PORT` (default `9464`) |
| `apps/worker` | own port, `WORKER_HEALTH_PORT` (default `9465`) - no other HTTP server | same port |
| `apps/blockchain-monitor` | own port, `MONITOR_HEALTH_PORT` (default `9466`) | same port |
| `apps/web` | `GET /health` (public port, App Router) | own port, `WEB_METRICS_PORT` (default `9467`) - production `server.js` only, not `next dev` |

`/metrics` is never on the same port as request/probe traffic on any
service - a deliberate choice (separate port over a bearer-token guard),
explained in ADR 0019. Logs are structured JSON (`LOG_LEVEL` controls the
threshold on all four services); a request id (`X-Request-Id`, adopted from
the caller when well-formed, generated otherwise) is carried through every
log line and error response for one request via `AsyncLocalStorage`.
`apps/worker` and `apps/blockchain-monitor` additionally expose per-loop
metrics (tick duration, items processed, last-success timestamp, error
count) and, for the monitor, `gateway_monitor_scan_lag_blocks{network}` -
how many blocks behind the chain tip that network's scan cursor is.

```bash
pnpm --filter @gateway/observability test # logger redaction, metrics shapes, ops-server probes
```

## RBAC, audit and secrets

Authorization is permission-driven, not role-name-driven at the call site:
`apps/api/src/auth/permissions.ts` maps every `PlatformPermission`/
`MerchantPermission` to the roles that hold it, and
`RequirePlatformPermission(...)`/`RequireMerchantPermission(...)` compute
the matching role list for the existing, unchanged
`PlatformRoleGuard`/`MerchantRoleGuard`. `MerchantRole.DEVELOPER` now
actually differs from `VIEWER` (it can manage API keys and webhook
endpoints); only `OWNER` can manage team membership
(`v1/merchant/me/members`), with a last-owner guard so that permission can
never strand a merchant with zero owners. See
[ADR 0014](docs/decisions/0014-rbac-permissions-and-membership.md).

`AuditLogService.record()` now captures the caller's IP and user agent
(`requestAuditMeta(request)`), and every merchant self-service mutation -
not just admin actions - writes an audit row in the same transaction as
the change itself. `GET /v1/admin/audit-logs` is the first way to actually
read that table through the API. `actorUserId` is now optional on
`record()`, for the first genuinely system-originated audit rows (Phase
12's signing audit trail, e.g. an HSM key-usage event with no human actor
in scope) - `actorType` becomes `"system"` with no `userId` foreign key,
rather than pointing that key at a fabricated user id.

Secrets (`DATABASE_URL`, `JWT_*_SECRET`, `ENCRYPTION_KEY`, `REDIS_URL`,
`COINGECKO_API_KEY`) are read through `@gateway/security`'s
`SecretsProvider` seam rather than `process.env` directly - swapping in a
KMS/Vault-backed provider in production is a one-line change at
`loadConfig()`'s call site. See
[ADR 0012](docs/decisions/0012-secrets-management.md).

```bash
pnpm --filter @gateway/security test # EnvSecretsProvider, RateLimiter
pnpm --filter @gateway/api test      # merchant-members.e2e, admin-audit-logs.e2e, env-secrets
```

## Signing service (durable and audited, no real backend - Mode A still not live)

`packages/signing` is the policy engine ADR 0002 named as Mode A's
prerequisite: destination allowlist, per-transaction and rolling-window
amount ceilings, a multi-approval workflow (now including `reject()`), and
a full audit trail of every submission, approval, rejection, signature and
failure (`PolicyEnforcingSigningService`), sitting in front of a
`SigningBackend` interface. `HsmKeyStore`/`EmulatedHsmKeyStore` add a
KMS/HSM-shaped key-management seam - real secp256k1 key generation and
ECDSA signing (Node's built-in `crypto`), with private key material held
only in a true ES private class field that no method, log, or
`JSON.stringify` can ever surface (proven directly in
`packages/signing/test/hsm-key-store.test.ts`). `HsmBackedSigningBackend`
composes that into a `SigningBackend` - signing the digest of a canonical
request payload, **not** a chain-serialized transaction (see
[ADR 0026](docs/decisions/0026-kms-hsm-signing.md) for exactly why that
boundary is deliberate). `DisabledSigningBackend` (always throws) remains
the only backend `SIGNING_BACKEND` may select in production -
`validateProductionConfig` refuses anything else.

`apps/api` now wires the whole engine up at `/v1/admin/signing/requests`
(list/get/submit/approve/reject, ADMIN-only to decide) with durable,
Postgres-backed `ApprovalStore`/`SpendTracker` (`signing_approval_requests`,
`signing_spend_entries` - approvals survive a restart) and an audit trail
that writes into the same append-only `audit_logs` table every other
privileged action already uses.
`apps/api/test/admin-signing.e2e.test.ts` proves the full lifecycle against
a real Postgres database, including two distinct approvers driving a
request to the ceiling and it *still* failing closed with no signature,
because Mode A is not live. **Not wired to `Settlement`/`Refund` approval**
(that composition, and the custody decision it depends on, is Phase 25's
job) and **no key-mapping UI exists yet** (`HsmBackedSigningBackend` throws
`NoKeyMappedError` until an operator wires a real address-to-key mapping -
there is no cloud KMS/HSM account in this project to build and test a real
key backend against, so none is implemented). See
[ADR 0013](docs/decisions/0013-signing-service.md) and
[ADR 0026](docs/decisions/0026-kms-hsm-signing.md).

```bash
pnpm --filter @gateway/signing test  # policy engine + HSM emulation, no infra required
pnpm --filter @gateway/api test -- admin-signing.e2e  # full lifecycle against real Postgres
```

## Database

17 tables plus supporting tables for idempotency, compliance and
reconciliation. Highlights:

| Table | Guarantee |
|---|---|
| `invoices` | Priced terms immutable after creation; `UNIQUE (merchant_id, order_id)` |
| `token_transfers` | `UNIQUE (network, tx_hash, transfer_index)` — the idempotency constraint |
| `ledger_entries` | Append-only; balanced per asset at COMMIT; amount always positive |
| `ledger_transactions` | Append-only; `UNIQUE idempotency_key` prevents double-posting |
| `ledger_accounts` | `cached_balance` is a read optimisation only - `@gateway/ledger`'s `computeAccountBalance` (full recompute) is the source of truth; `reconcileAccount` cross-checks and flags drift instead of correcting it |
| `payment_events` | Append-only, gap-free `sequence` per invoice |
| `reconciliation_discrepancies` | Never auto-resolved; only an admin transition closes one |
| `audit_logs` | Append-only |
| `chain_cursors` | Leased scan position per network, so a crash re-processes rather than skips |
| `idempotency_keys` | Request replay returns the stored response, never re-executes |

```bash
pnpm db:studio        # browse
pnpm db:migrate       # create a migration (needs a shadow database)
```

## Commands

| Command | Purpose |
|---|---|
| `pnpm build` | Compile all packages |
| `pnpm test` | Run every suite - green from a clean shell with no `.env` needed (`TEST_DATABASE_URL` set another way, e.g. CI's own env) or with `.env` present locally; see [ADR 0020](docs/decisions/0020-test-database-isolation.md) |
| `pnpm test:db:migrate` | Apply Prisma migrations to `TEST_DATABASE_URL` - run once before `pnpm test` against an empty test database (what CI does) |
| `pnpm test:integration` | Cross-package suites against real infra (Postgres + real loopback HTTP) - `@gateway/database`, `@gateway/webhooks`, `@gateway/ledger`, `@gateway/worker`, `@gateway/blockchain-monitor`; no mocked transport or DB |
| `pnpm test:e2e:web` | Browser E2E suite for `apps/web` (Playwright, ADR 0017) - builds and runs a real production instance against the real API |
| `pnpm typecheck` | Type-check without emitting |
| `pnpm lint` | ESLint across all 14 packages/apps (`apps/web` had its own config already; Phase 9.5 added one - `eslint.config.base.mjs` plus a re-export per project - to the other 13, so CI's lint gate actually checks something everywhere, not just `apps/web`) |
| `pnpm db:generate` | Regenerate the Prisma client |
| `pnpm db:migrate:deploy` | Apply migrations |
| `pnpm seed` | Create a test merchant with credentials |
| `pnpm dev:infra` | Start Postgres + Redis via Docker |
| `pnpm dev:pg:start` | Start the no-Docker PostgreSQL cluster |
| `pnpm dev:worker` | Run the webhook dispatch + expiry sweep loops |
| `pnpm loadtest:seed` | Provision fixture data for load testing (needs `pnpm dev:api` already running - see `apps/api/loadtest/README.md`) |
| `pnpm loadtest -- <scenario\|all>` | Run one (or all) of the four `autocannon` load-test scenarios (ADR 0015) |
| `pnpm test:coverage` | Same suites as `pnpm test`, instrumented with `@vitest/coverage-v8` (Phase 15, ADR 0028) |
| `pnpm test:coverage:report` | Combine every project's coverage into one repo-wide baseline (`coverage/summary.json`) |
| `pnpm licenses:check` | Fail if any production dependency's licence is outside the allowlist (Phase 15) - a real CI gate |
| `pnpm sbom` | Generate a CycloneDX SBOM (`sbom/sbom.cdx.json`) from `pnpm licenses list` (Phase 15) |
| `pnpm notice` | Regenerate `NOTICE` (third-party attributions) from `pnpm licenses list`; CI diffs the result against the committed copy |
| `pnpm audit:report` | Run `pnpm audit --prod`, write `security-reports/pnpm-audit.json` - a real CI gate since Phase 17 pass 1 (Phase 15 added it informationally) |

## Roadmap

| Phase | Scope | Status |
|---|---|---|
| 1 | Monorepo, schema, integrity guards, money, credentials | Done |
| 2 | Merchants, API keys, invoice creation, expiry (HTTP API) | Done - lazy expiry plus the Phase 6 proactive sweep, see API section above |
| 3 | `BlockchainAdapter` interface, transfer parsing, address validation | Done for EVM - `EvmJsonRpcAdapter` verified live against Sepolia (ADR 0010); done for Bitcoin too - `BitcoinRpcAdapter` verified against a real regtest node (ADR 0027, Phase 13 of `README.md#roadmap`) |
| 4 | Monitor, matching, confirmation engine, state machine | Done - proven against `FakeBlockchainAdapter` and live EVM RPC via `ChainScanner`; also proven against real Bitcoin regtest, including a real reorg and a duplicate-transaction case (ADR 0027) |
| 5 | Double-entry ledger, balances, reconciliation | Done |
| 6 | Webhook events, HMAC, retries, replay protection | Done - `apps/worker` + `packages/webhooks` (ADR 0009); also added the proactive expiry sweep flagged as a Phase 2 known limitation |
| 7 | Merchant dashboard, admin dashboard, payment page | Backend API done (see API section above). `apps/web` frontend: merchant + admin dashboards built, read and write functional (auth, role gating, all list/detail views, plus every write action - see Phase 18 below). Hosted payment page (`/pay/[invoiceId]`) renders and polls real data via the new public `GET /v1/public/invoices/:id`, and now renders a scannable payment QR (BIP-21/EIP-681, ADR 0018) alongside the deposit address, built server-side in `packages/shared` and returned as `payment_uri` on both invoice response shapes |
| 8 | Rate limiting, RBAC, audit, secrets, signing service | Rate limiting done (ADR 0011). RBAC is now permission-driven (`permissions.ts`, ADR 0014) with a merchant member-management endpoint closing the loop on role assignment. Audit trail now covers merchant self-service actions too, plus an admin `GET /v1/admin/audit-logs` endpoint and ip/user-agent capture. Secrets management has a `SecretsProvider` seam (ADR 0012). Signing service has its policy engine built (ADR 0013) - allowlist/ceilings/approvals - but no real KMS/HSM backend and not wired into the API; Mode A remains not live |
| 9 | Unit, integration, E2E, security, load testing | Unit tests exist per package. Integration testing now covers cross-package flows against real infra, not mocks - `packages/database/test/integrity.test.ts` (schema guarantees), `packages/webhooks/test/dispatcher.live-http.test.ts` (real loopback HTTP delivery, no `fetchImpl` mock), and `apps/blockchain-monitor/test/full-pipeline.e2e.test.ts` (simulated on-chain payment through detection, ledger posting, and real webhook delivery in one run - see `pnpm test:integration`). `apps/api`'s `*.e2e.test.ts` suite already boots the real Nest app against real Postgres + Redis. E2E browser testing done (ADR 0017, `apps/web/e2e/`) - 20 Playwright tests (38 as of Phase 18, which added every dashboard/admin write action and its role restrictions) drive a real production build of `apps/web` against the real API: login/session gating, every merchant and admin dashboard page, role-based route protection, and the public hosted payment page (unknown-invoice and a real API-driven invoice fixture); see `pnpm test:e2e:web`. Found and fixed a real bug: `apps/web`'s fetch error parser read `{ message, code }` off the wrong level of the API's error envelope (which nests both under `error`), so every API error shown in the UI silently fell back to a generic HTTP status string instead of the real message. Load testing done (ADR 0015, `apps/api/loadtest/`) - confirmed the ADR 0011 rate limiter enforces its configured ceilings under real concurrent load, and found + fixed a real bug: concurrent writers against one hot row (one merchant's address pool, one user's login) were exhausting `runInTransaction`'s `Serializable`-isolation retry budget and surfacing as opaque 500s (44.9%/65.4% error rates at 20 concurrent connections). An advisory lock around the contended sections looked like the fix and measurably was not - a `Serializable` snapshot is fixed before a lock wait resolves, so it cannot prevent the conflict. The actual fix: `invoices.service.ts#createInvoice` and `auth.service.ts#login` now run at Read Committed instead, safe because neither has a multi-row invariant `Serializable` was protecting - re-verified at 0% errors and 7-23x the throughput at both 20 and 50 concurrent connections; `runInTransaction`'s default `maxRetries` (8, was 3) stays as general hardening for the ~18 other call sites that correctly remain `Serializable`. See ADR 0015 for the full story. Security testing done (ADR 0016) - 36 new `apps/api/test/security/*.e2e.test.ts` tests (API-key lifecycle edge cases, broken-access-control/resource-ID-confusion sweep, JWT forgery resistance, mass-assignment/injection/sensitive-data-exposure, transport hardening). Found and fixed a test-infra gap that had silently disabled `ValidationPipe` in every e2e test (production was never affected - see ADR 0016), a real bug misclassifying an oversized request body as a 500 instead of a 413, and neutralized a critical `@fastify/middie` dependency vulnerability (`skipMiddie: true`, unused in this app). Left open: API-key `scopes` are stored/returned but never enforced by any guard, and `@nestjs/core`/`@nestjs/platform-fastify` bundle an old Fastify 4.x with several unpatched high-severity advisories - closing that requires a NestJS major-version upgrade, deliberately out of scope for this pass (see ADR 0016's follow-ups) |
| 9.5 | Phase 10 prerequisites: git, Docker build, health/readiness, graceful shutdown, structured logging + metrics, deterministic tests, CI-ready lint | Done - see the sections above and [ADR 0019](docs/decisions/0019-observability.md)/[ADR 0020](docs/decisions/0020-test-database-isolation.md) for the two non-trivial calls made along the way. `git init`'d (this was not a git repository before this pass). `infrastructure/docker/Dockerfile` now builds all four targets (`api`/`worker`/`monitor`/`web`) - fixed a missing `packages/exchange-rate`/`packages/signing` (now also `packages/observability`) `package.json` COPY that made `--frozen-lockfile` reject the lockfile outright, and added a `.dockerignore` that was missing entirely (the build context, and every image layer, previously included the host's own `node_modules`, `.pgdata/`, and `.env`). All three non-`apps/api` services now expose `/health`+`/ready` (`apps/worker`/`apps/blockchain-monitor`: a `node:http` listener, since neither had any HTTP server; `apps/web`: an App Router route) plus a `HEALTHCHECK` in the Dockerfile. `apps/api` now drains in-flight requests before closing on `SIGTERM`/`SIGINT` - verified against a real Docker container: `docker kill --signal=TERM` mid-request, the request completes (HTTP 200, not cut off), and the container exits with code 0. That same live test surfaced a real bug - `RedisLifecycle.onModuleDestroy()` threw synchronously when the Redis connection was already closed, which would have crashed the shutdown instead of completing it; hardened directly (see ADR 0019). That test originally ran against the `debug` Docker target, not the runtime image the section below corrects - a second SIGTERM-handling bug (`app.enableShutdownHooks()`) surfaced only once the runtime image itself actually ran; also fixed, see ADR 0019's correction and ADR 0021. `@gateway/observability` (new package) gives all four services structured JSON logs routed through `@gateway/security`'s redaction and Prometheus `/metrics` on a port separate from request/probe traffic; `GET /v1/ready` now also checks Redis, not only the database. `TEST_DATABASE_URL` is now actually read (it never was) by every integration suite via a shared Vitest setup file; found + fixed a real bug this surfaced - `sweepExpiredInvoices`'s unordered `take: batchSize` query gave no fairness guarantee under a backlog: it still converges once new expirations stop arriving (each tick removes whichever subset it returns from the candidate pool), but under sustained arrivals at or above `batchSize` per tick, specific invoices could be repeatedly skipped with no bound on how long; fixed with `ORDER BY expires_at ASC`, which also bounds the worst case to oldest-first draining rather than an unordered lottery (also a genuine production correctness fix, not just a test one). ESLint now runs on all 14 packages/apps, not just `apps/web` - found and fixed a handful of real dead-code/lint findings along the way. **Correction, same-day follow-up audit:** the original "all four Docker targets build successfully end to end" claim above was false - it was based on `docker build` succeeding, never on running the resulting image. The runtime image did not actually work: `pnpm prune --prod` (the stage every runtime target copied from) hung forever on an unanswerable confirmation prompt, and bypassed, it deleted every workspace project's own dependency symlinks (not just devDependencies), so every runtime target crashed with `Cannot find module` before reaching a database. Replaced with `pnpm deploy --prod` per target (see [ADR 0021](docs/decisions/0021-docker-runtime-deploy.md)) and re-verified for real this time: all four images build from a cold cache without hanging; each container runs as the unprivileged `node` user from its own image's own `CMD`, reaches Docker `HEALTHCHECK` `healthy`, and answers its `/health`/`/ready`/`/metrics` endpoints (`api`'s `/metrics` confirmed absent from its public port, present only on the ops port); `api` login round-trips through `@node-rs/argon2` and a real Prisma query; `SIGTERM` drains in-flight work and exits 0 for `api`/`worker`/`monitor`. `scripts/docker/smoke-test.mjs` checks all of this on demand and is the thing that should have existed the first time. |
| 10 | Kubernetes, monitoring, backups, DR, CI/CD | **Baseline done** for all four areas, per the explicit Phase 10 scope boundary (production depth is Phase 11/14/15/16 - see `README.md#roadmap`). Every claim below was independently re-run, not just built. **Kubernetes** (ADR 0024): `infrastructure/kubernetes/` manifests for api/worker/monitor/web plus an in-cluster Postgres/Redis and a migration Job, deployed to a real local `kind` cluster - all 8 workloads reached `1/1 Ready` with 0 restarts, verified by a real database-backed request (`POST /v1/auth/login` through the in-cluster `api` pod round-tripped through `@node-rs/argon2` and a real Prisma query, 200 OK) and by hitting every service's `/health`/`/ready`/`/metrics` from inside the cluster. Two real manifest bugs were found and fixed by this deploy, not by review: `terminationGracePeriodSeconds` nested one level too deep (a strict-decoding API error), and a `livenessProbe` with no `startupProbe` that raced the app's own boot time and killed `api`/`web` once each on the first real deploy - fixed by adding a `startupProbe` to all eight workloads (see ADR 0024's addendum, which also covers a later CrashLoopBackOff Grafana hit from sustained host resource pressure during this same pass's CI testing, and how it was diagnosed and recovered). **Monitoring** (`infrastructure/kubernetes/monitoring/`): Prometheus scrapes all four services' real `/metrics` (confirmed `"health":"up"` on every target, with real values e.g. `gateway_worker_last_success_timestamp_seconds` matching the worker's actual poll-loop ticks) and Grafana serves one provisioned dashboard ("Gateway - Baseline (Phase 10)") whose panel queries were verified to resolve against that live data through Grafana's own datasource proxy. **Backup/DR baseline** (ADR 0022): `scripts/backup/pg-backup.sh`/`pg-restore.sh` plus an in-cluster nightly CronJob were run for real - a live backup (112,929 bytes) was taken from the seeded database, restored into a separate, freshly created database, and its contents (merchant id/name/slug, 96 ledger accounts) were compared field-by-field against the live database and matched exactly. Point-in-time recovery and measured RPO/RTO are explicitly Phase 14, not this baseline. **CI/CD** (ADR 0023): `.github/workflows/ci.yml` (lint, typecheck, test against real Postgres/Redis, build, then a Docker build of all four runtime targets + `scripts/docker/smoke-test.mjs`) - proven with `nektos/act` locally rather than a real GitHub Actions run, since no GitHub remote exists yet (a deliberate choice, not an oversight - creating one was left to the repo owner). Three of four jobs (`lint-typecheck`, `test`, `docker-smoke`) pass end-to-end under `act`; `docker-smoke` in particular is the strongest evidence here, since it drives the real Dockerfile and finished `=== ALL CHECKS PASSED ===`. The fourth (`build`, a bare `pnpm build` with no Docker involved) fails only under `act`'s specific Ubuntu runner image (a Next.js prerender crash on `apps/web`) and was root-caused to that image, not this codebase - the equivalent real build (`docker build --target web`, `node:22-alpine`) has succeeded repeatedly and that image is the one actually running in the verified `kind` deployment above; a real GitHub Actions run is the natural next step to close this out fully. Along the way, three real, unrelated bugs were found and fixed purely by actually running the pipeline: `pnpm typecheck`/`pnpm test` both needed library packages built first on a clean checkout (their compiled `dist/` isn't in git); `act`'s own `.env`-autoload convenience feature (not a GitHub Actions behavior) leaked this repo's real local dev secrets into a CI run and had to be suppressed with `--env-file`; and a hand-typed dummy `ENCRYPTION_KEY` decoded to 33 bytes instead of 32. `infrastructure/docker/Dockerfile` itself also picked up a real fix this pass: `pnpm deploy --prod` failed once on an npm registry timeout mid-build - tested `--offline` (rejected, fails deterministically on any semver-range dependency's metadata resolution) and adopted `--prefer-offline` instead (see ADR 0021's addendum) - the registry dependency is irreducible while pnpm's legacy deploy mode is required, so CI needs real network access and a transient failure there should simply be retried. |
| 11 | Production configuration validation, TLS/reverse-proxy, RPC fallback, resource limits, deployment guide | **Done** for this phase's scope (see `docs/decisions/0025-production-readiness.md` and `docs/operations/deployment-guide.md`); zero-cost pass - no real domain or mainnet RPC account exists, both disclosed as limitations. **Config validation**: `apps/api`, `apps/worker` and `apps/blockchain-monitor` each gained a `validateProductionConfig()` that refuses to boot under `NODE_ENV=production` on a placeholder secret, an unsafe CORS origin, a disabled SSRF guard, or a mainnet RPC network with no fallback URL - 19 new unit tests (`apps/api`, `apps/worker` and `apps/blockchain-monitor`'s own `production-config.test.ts` files) cover every Phase 11 rule, and the *positive* case was independently re-verified live: the in-cluster `kind` deployment was rebuilt with the new production-shaped `CORS_ALLOWED_ORIGINS`/RPC config and all four services rolled out to `1/1 Ready` with 0 restarts (a config the old Phase 10 baseline used, `http://localhost:3000`, would now be refused by this same check). **RPC fallback**: `POLYGON_RPC_FALLBACK_URL`/`BSC_RPC_FALLBACK_URL` wired alongside the existing Ethereum one (`EvmRpcClient`'s failover logic already existed and was already tested - only the config plumbing was missing for two of three mainnet networks). **`NEXT_PUBLIC_API_URL` bake-in bug fixed** (flagged as a known limitation in ADR 0024's addendum): `infrastructure/docker/Dockerfile`'s `web` target now takes it as a build ARG, verified by rebuilding the image with `--build-arg NEXT_PUBLIC_API_URL=https://api.gateway.local:8443` and confirming the deployed pod actually called that URL. **TLS/reverse-proxy**: `infrastructure/kubernetes/ingress.yaml` (host-based routing to `api`/`web`) plus a cert-manager `selfSigned` `ClusterIssuer` (`infrastructure/kubernetes/cert-manager/`) - both installed for real (ingress-nginx v1.11.3, cert-manager v1.16.2) and verified live: `curl --resolve api.gateway.local:8443:127.0.0.1 -k https://api.gateway.local:8443/v1/health` and the same for `/v1/ready` and `app.gateway.local`'s `/health` all returned `200` through a real TLS handshake and host-based Ingress routing to the freshly-rolled-out pods. No browser-trusted CA behind it (disclosed) - the deployment guide gives the one-annotation swap to a real ACME issuer once a domain exists. **Resource limits**: documented with their reasoning in the deployment guide's table (not load-test-measured - that stays Phase 28's job, per the roadmap's own boundary). **Deployment guide**: `docs/operations/deployment-guide.md`, written and followed step-by-step while producing the evidence above, not drafted from the manifests alone. **Found, not fixed (out of scope)**: `apps/api/test/admin-audit-logs.e2e.test.ts`'s first case fails consistently, including on the pre-Phase-11 baseline - a plausible audit-log-write race, left for Phase 16/17. |
| 14 | Point-in-time recovery, measured RPO/RTO, executed recovery drill, Redis recovery, DR runbook | **Mostly done** for this phase's scope (see [ADR 0029](docs/decisions/0029-point-in-time-recovery.md) and [`docs/operations/disaster-recovery-runbook.md`](docs/operations/disaster-recovery-runbook.md)); offsite/cross-region backup storage disclosed as the remaining production-dependent gap. **PITR mechanism**: continuous WAL archiving (`archive_mode=on`, `archive_timeout=60`) to a dedicated `wal-archive` PVC, daily `pg_basebackup` (`infrastructure/kubernetes/backup/basebackup-cronjob.yaml`) alongside the existing nightly `pg_dump`, and a restore mechanism (`scripts/backup/pg-restore-pitr.sh`, `pitr-restore-job.template.yaml`) - all applied and run for real against a live `kind` cluster, not just written. **The executed drill**: seeded a merchant (96 ledger accounts), created 2 invoices, took a real base backup (4,244,605 bytes, completed 18:29:39 UTC), created 2 more invoices and advanced the blockchain scanner's `chain_cursors` lease *after* that backup, forced an immediate WAL archive, declared a disaster at 18:31:07 UTC, and actually deleted the live `postgres-data` PVC and pod - a real loss of the database and its filesystem. Restored via the new PITR mechanism to the latest available point; Postgres's own recovery log confirms real WAL replay (`redo starts at 0/B000028` ... `redo done at 0/D00E788` ... `archive recovery complete`), not just a bare base-backup restore. **Verified after restore**: all 4 invoices present (2 pre-backup, 2 post-backup - proving WAL replay recovered data beyond the base backup snapshot), `chain_cursors` held the post-backup value (`9000250`, not the stale `9000000`) with its lease intact, zero duplicate `(network, tx_hash, transfer_index)` groups in `token_transfers`, and a real run of the production `runLedgerReconciliation` function reported `CLEAN` across all 96 accounts with zero discrepancies (`scripts/kubernetes/dr-verify.cjs`). A real `POST /v1/auth/login` returned `200` against the restored database, and all four services reached `Ready`. **Measured RPO: effectively 0** in this run (an operator-forced `pg_switch_wal()` immediately before the disaster) - **worst-case RPO bounded at <=60s** by `archive_timeout` for an unplanned loss. **Measured RTO: 154 seconds** (disaster declared to Postgres verified `Ready`), of which WAL replay itself took under 5 seconds - RTO here is dominated by Kubernetes PVC/pod churn, not replay time. **Redis recovery**: a real drill (`scripts/kubernetes/redis-recovery-drill.sh`) deleted the Redis Deployment and its PVC (a genuine AOF loss); Redis came back empty in ~17 seconds and `api`/`worker`/`monitor` all returned to `Ready` within ~2.5 minutes using only Postgres-held state, with `chain_cursors` confirmed unchanged by the Redis loss. **Two real bugs found and fixed by running this, not by review**: the official Postgres image's default `pg_hba.conf` does not authorize replication connections even for a superuser (`all` does not match a replication connection) - `pg_basebackup` failed until a `postgres-initdb` ConfigMap (`/docker-entrypoint-initdb.d/pg-hba-replication.sh`) added the missing rule on first boot, re-verified working automatically afterward; and the first base-backup attempt (an ad hoc `kubectl exec pg_basebackup` inside the `postgres` pod) wrote to a path that pod never mounts, losing that backup along with the pod at the disaster step - caught when the restore Job found nothing to restore from, and the drill was re-run correctly through the real CronJob mechanism before destroying anything a second time (full account in ADR 0029). **Not built, disclosed**: offsite/cross-region backup storage (WAL archive and both backup mechanisms still live on local cluster PVCs), and a full `kind delete cluster` node-level teardown was deliberately not repeated for this drill since that would destroy the backup store itself rather than test a realistic primary-database loss - reinforced by this machine's concurrent, unrelated load at the time causing even a second fresh `kind` cluster's control plane to repeatedly fail to boot (independent evidence for the same judgment call, detailed in ADR 0029). |
| 16 | Financial metrics, financial alert rules, dashboard specification, operations runbook, incident response procedure | **Done** (see [ADR 0030](docs/decisions/0030-observability-operations-and-incident-response.md)). **Finding fixed**: `runLedgerReconciliation` (`packages/ledger`) was fully implemented and tested but never called by any application - reconciliation never ran automatically. `apps/worker` now runs it as a scheduled poll loop (`WORKER_RECONCILIATION_INTERVAL_MS`, default 1 hour), proven by a test that deliberately corrupts a `ledger_accounts.cached_balance` row and shows the scheduled sweep detects and records the discrepancy without auto-correcting it (SPEC section 21). **Financial metrics** added and wired at their real call sites: webhook failures/backlog (`apps/worker`), payment/confirmation latency and payments-processed (`MonitorService`, `apps/blockchain-monitor`), settlement status and open reconciliation discrepancies (a new `financial_health` loop in `apps/worker`), RPC failures (`instrumentAdapter`, a wrapper adding no dependency to `packages/blockchain`), signing failures (`MetricsRecordingSigningAuditTrail`, `apps/api`), and database/Redis availability via an independent timer rather than a repurposed `/ready` (`startDependencyHealthGauge`, `packages/observability`). **All 9 required alert rules** (`infrastructure/kubernetes/monitoring/alert-rules.yaml`: blockchain monitor stopped, scan lag increasing, reconciliation discrepancy detected, webhook delivery backlog, database unavailable, Redis unavailable, RPC provider unavailable, signing failure, abnormal payment processing rate) were proven to fire twice over: `promtool test rules` against the exact pinned Prometheus image this deployment uses (`prom/prometheus:v3.7.3`) with synthetic time series shaped like each real failure, and live in this environment's real `kind` cluster - all 9 rules loaded with `health: "ok"`, existing scrape targets unaffected, confirmed via Prometheus's own `/api/v1/rules` and `/api/v1/query` endpoints. A second Grafana dashboard ("Gateway - Financial Operations") was added alongside the Phase 10 baseline one and confirmed provisioned and reachable in the same live cluster. `docs/operations/dashboard-specification.md`, `operations-runbook.md` and `incident-response.md` are written. **Not built, disclosed**: Alertmanager notification routing (rules evaluate and expose `ALERTS`; nothing pages a human outside the dashboard yet); every alert threshold is a disclosed example pending real production traffic (Phase 24/31); `gateway_settlements_by_status` correctly reads zero until Phase 25 ships settlement creation. **Found, not fixed (out of scope)**: a pre-existing, unrelated shared-test-database flake in `apps/blockchain-monitor/test/full-pipeline.e2e.test.ts` (`EncryptionError: malformed ciphertext`), reproducible on `main` in files this phase never touched. |
| 17 pass 1 | Security hardening: dependency remediation, API-key scope/livemode enforcement, least-privilege database role, merchant-suspension revocation, threat model, findings register | **Done** (see [ADR 0031](docs/decisions/0031-security-hardening-pass-1.md), [`docs/security/threat-model.md`](docs/security/threat-model.md), [`docs/security/findings-register.md`](docs/security/findings-register.md)). **Dependency remediation**: `pnpm audit --prod` went from 1 critical + 9 high (17 advisories total, across every severity) to **zero across every severity** - `@nestjs/common`/`core`/`platform-fastify`/`testing` upgraded 10.4.15 → 11.2.3 (removes the `@fastify/middie` dependency chain entirely rather than patching it), `@fastify/cookie`/`cors`/`helmet` upgraded to their Fastify-5-compatible majors, plus `pnpm.overrides` for `deepmerge-ts` and `fastify`; the CI `vulnerability-scan` job and `scripts/security/audit-report.mjs` both flipped from informational to a real gate now that the count they track is zero. **API-key scopes**: `ApiKey.scopes` was stored and returned but never checked by any guard - a new `ApiKeyScopeGuard` (mirroring `MerchantRoleGuard`'s existing `Reflector`/`SetMetadata` pattern) now enforces it on every API-key-guarded controller, proven by rejecting an under-scoped key and by flipping a pre-existing test that had explicitly documented the gap as "KNOWN GAP" to its now-passing, enforced form. **Test/live key and network separation**: a new `assertNetworkMatchesLivemode` (`packages/shared`) rejects a test-mode key targeting a mainnet network and a live key targeting a testnet, at both invoice creation and address registration, proven in both directions on both endpoints. **Database role**: every service connected to Postgres as `gateway`, a superuser needed only for point-in-time-recovery replication - a new least-privilege `gateway_app` role (no DDL, no superuser) now carries all production runtime traffic, proven by connecting as it and having every DDL/privilege-escalation attempt rejected while CRUD and future-table grants (via `ALTER DEFAULT PRIVILEGES`) succeed. **Merchant suspension**: `MerchantRoleGuard` now revokes dashboard access on the very next request after a merchant is suspended, not just eventually via API-key traffic (`ApiKeyGuard` already checked this); the narrower, currently-unreachable user-level suspension exposure is formally accepted and bounded to one `JWT_ACCESS_TTL_SECONDS` (default 15 minutes), consistent with an existing test's own documented rationale. **Bonus finding, fixed**: the admin audit-log listing endpoint's ascending sort order was hiding recent matching events once accumulated history passed one page - twice misdiagnosed across ADRs 0025/0030 as a flaky "write race," root-caused by direct row-count evidence and fixed (newest-first ordering). Full regression after every change: `pnpm --filter @gateway/api test` 179/179, `pnpm --filter @gateway/database test` 32/32 (including 6 new least-privilege-role proofs), `pnpm --filter @gateway/shared test` 89/89. **Disclosed, not this pass's scope**: the webhook SSRF guard's documented DNS-rebinding TOCTOU gap remains open; local development and the test suite still connect to Postgres as the migration role, not `gateway_app` (the production Kubernetes path is what changed). Phase 17 pass 2 (Tier 2 feature attack surface) is unchanged, still scheduled before Phase 30. |
| 18 | Merchant and operator dashboard actions | **Done** (see `README.md#roadmap`'s Phase 18 section for the full account). Every merchant write action (API key create/revoke, webhook endpoint create/toggle/edit-events/rotate-secret/test, team member add/change-role/remove on a new "Team" page) and every operator write action (compliance review, merchant suspend/reactivate, reconciliation discrepancy resolution, refund approve/reject, plus a new filterable/paginated audit-log page) now works from `apps/web`, re-verified against a real running `apps/api` and Postgres - not just built. Every role check the UI hides is independently re-enforced by the API regardless of what the client sends, proven by E2E tests that call the raw API directly as a merchant, a DEVELOPER-role member, and a SUPPORT platform user and confirm each gets a `403`. 38 Playwright tests total (up from 20). **Two real, pre-existing bugs found and fixed only by driving the browser against the live stack, unrelated to this phase's own code**: `@fastify/cors`'s default `methods` list (`GET,HEAD,POST`) was silently blocking every PATCH/DELETE dashboard request - every earlier browser mutation had been POST-only, so this never surfaced before now (fixed in `apps/api/src/bootstrap.ts`, with two new regression tests in `apps/api/test/security/http-hardening.e2e.test.ts`); and `apps/api` failed to boot at all with metrics enabled, because Phase 16's dependency-health gauge pinged Redis before `RedisLifecycle` ran its own guarded connect, racing ioredis's lazy-connect into a hard crash (fixed in `apps/api/src/common/redis.module.ts`). **Disclosed, not built**: no pagination/filter UI was added to the other admin list pages (merchants, compliance, reconciliation, refunds, settlements) - each still shows only the API's first page of 20 rows; registering a deposit address stays API-key-only by design and has no dashboard UI. |

## Security

Report vulnerabilities privately; do not open a public issue.

Never commit `.env`. Every secret in `.env.example` must be unique per
environment and rotated on a schedule. In production, `ENCRYPTION_KEY` comes
from a KMS, not from an environment variable.

[`docs/security/threat-model.md`](docs/security/threat-model.md) and
[`docs/security/findings-register.md`](docs/security/findings-register.md)
record this project's threat model and every security finding from Phase 17
pass 1 (current-surface hardening, ADR 0031) - severity, exploit scenario,
mitigation and status for each, including what remains open and why. Phase
17 pass 2 extends the same register to cover Tier 2 feature attack surface
before Phase 30 runs.

## Compliance

This software provides extension points for KYC, KYB, AML screening, sanctions
screening, transaction monitoring, travel-rule integration and geographic
restrictions. It does not implement them, and it makes no representation that
any deployment is compliant in any jurisdiction. Operating a crypto payment
service is a regulated activity in most countries. Obtain legal advice and the
required licences before processing real funds.

## License

All Rights Reserved. See [`LICENSE`](LICENSE). This repository is published
for viewing as a portfolio project; no licence to use, copy or distribute it
is granted.
Third-party open-source components are used under their own licences,
attributed in [`NOTICE`](NOTICE) (`pnpm notice` to regenerate; checked in CI
against the committed copy).
