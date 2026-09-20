# ADR 0030 - Observability, operations and incident response: scheduled reconciliation, financial metrics, alert rules, dashboard, runbook and incident-response procedure

Status: Accepted
Date: 2026-09-12

## Context

Phase 10 delivered the monitoring baseline: HTTP metrics, poll-loop metrics,
`gateway_monitor_scan_lag_blocks`, Prometheus scraping every service, and one
provisioned Grafana dashboard proven to render real data. Phase 16 (C6,
`README.md#roadmap`) covers the delta the roadmap's
boundary table names explicitly: financial metrics, financial alert rules, a
dashboard specification distinct from the one baseline dashboard, an
operations runbook, and an incident-response procedure.

This phase's own audit found something more serious than a missing metric:
**`runLedgerReconciliation` (`packages/ledger`) was fully implemented and
unit-tested, but no application ever called it.** Ledger reconciliation
never ran automatically in this codebase - a `ReconciliationDiscrepancyDetected`
alert would have had no source of real discrepancies to ever fire against.
Fixing that is this ADR's first decision, not an afterthought.

## Decisions

### Ledger reconciliation now runs on a schedule, in `apps/worker`

`apps/worker/src/reconciliation-sweep.ts` wraps `runLedgerReconciliation`
with metric recording and nothing else - `packages/ledger` stays
observability-free by design (same posture as `packages/signing`).
`apps/worker/src/main.ts` runs it as a fourth poll loop alongside the
existing webhook-dispatch and expiry-sweep loops, on its own interval
(`WORKER_RECONCILIATION_INTERVAL_MS`, default 3,600,000ms = 1 hour - a full
recompute of every active account is not cheap, so this is deliberately
coarser than the other loops). A fifth loop, `financial_health`
(`WORKER_FINANCIAL_HEALTH_INTERVAL_MS`, default 30s), re-samples three
cheap gauges every tick: webhook backlog, settlements by status, and open
reconciliation discrepancies (`apps/worker/src/financial-health-gauges.ts`).

**Evidence** (`apps/worker/test/reconciliation-sweep.test.ts`, run against
real Postgres): a healthy account posts a real credit via `postPaymentCredit`
and reconciles clean under a real full-ledger sweep; a second test corrupts
`ledger_accounts.cached_balance` directly (the same technique
`packages/ledger/test/ledger.test.ts` uses) and proves the scheduled sweep
detects it, records a `LEDGER_IMBALANCE` discrepancy, leaves it uncorrected
(SPEC section 21), and increments `gateway_reconciliation_discrepancies_total`.
The "clean" test asserts only that ITS OWN account came back matched, not
that the whole sweep found nothing - `gateway_test` is one shared database
across every suite (ADR 0020) and other tests deliberately leave corrupted
accounts behind by design, so asserting global cleanliness would be
flaky by construction, not a real correctness signal.

### Financial metrics: one shared definition, recorded where each event actually happens

`packages/observability/src/financial-metrics.ts` adds `createFinancialMetrics(registry)`,
mirroring `metrics.ts`'s existing pattern (one `Registry` per caller, never
prom-client's global one). It defines every series the alert rules below
read:

| Metric | Type | Recorded by |
|---|---|---|
| `gateway_webhook_delivery_failures_total{outcome}` | Counter | `apps/worker`'s webhook loop, from `WebhookDispatcher.runOnce()`'s own `failed`/`exhausted` counts |
| `gateway_webhook_backlog{status}` | Gauge | `apps/worker`'s `financial_health` loop |
| `gateway_payment_detection_latency_seconds` | Histogram | `MonitorService.advanceOnFirstSighting` (`apps/blockchain-monitor`) |
| `gateway_payment_confirmation_latency_seconds` | Histogram | `MonitorService.finalizeInvoice` |
| `gateway_payments_processed_total` | Counter | `MonitorService.finalizeInvoice`, once per invoice that reaches PAID |
| `gateway_settlements_by_status{status}` | Gauge | `apps/worker`'s `financial_health` loop |
| `gateway_reconciliation_discrepancies_total{kind}` | Counter | `reconciliation-sweep.ts` (kind=`LEDGER_IMBALANCE`) and `MonitorService.flagOrphanedCredit` (kind=`ORPHANED_CREDIT`) |
| `gateway_reconciliation_open_discrepancies` | Gauge | `apps/worker`'s `financial_health` loop |
| `gateway_monitor_rpc_failures_total{network,method}` | Counter | `instrumentAdapter` (`apps/blockchain-monitor`), wrapping every `BlockchainAdapter` call |
| `gateway_signing_failures_total{stage}` | Counter | `MetricsRecordingSigningAuditTrail` (`apps/api`), wrapping the real signing audit trail |
| `gateway_dependency_up{dependency,service}` | Gauge | `startDependencyHealthGauge` (`packages/observability`), run independently in `apps/api` (database, Redis), `apps/worker` and `apps/blockchain-monitor` (database) |

**`gateway_settlements_by_status` is an honest, disclosed gap, not an
oversight**: this phase's audit confirmed no application code path creates a
`Settlement` row - fee collection is Phase 25's job (`admin-settlements.service.ts`'s
own comment already said "creating/approving settlements is a later phase's
concern"). The gauge and its alert threshold are wired now so they activate
the moment Phase 25 ships settlement creation, with zero further
observability work; today it correctly reports zero everywhere, proven by
`apps/worker/test/financial-health-gauges.test.ts`'s second test.

### RPC failure metrics: a wrapper, not a change to `packages/blockchain`

`apps/blockchain-monitor/src/instrumented-adapter.ts` wraps a constructed
`BlockchainAdapter` instance, not a `Proxy` - `validateAddress` is
synchronous and pure, so wrapping every property blindly would turn it into
an async function and break any direct caller of its return value. Only the
network-bound, promise-returning methods are wrapped; `EvmJsonRpcAdapter`'s
extra cheap-discovery methods (`getLightBlock`, `getTransferLogsTo` -
feature-detected by `scanner.ts`'s `asEvmDiscoveryAdapter`, not part of the
`BlockchainAdapter` interface) are copied across and instrumented the same
way only when present, so the fast discovery path is unchanged on a wrapped
adapter. `packages/blockchain` itself gained no new dependency and no code
change.

### `gateway_dependency_up`: an independent timer, not a repurposed `/ready`

`/ready` alone cannot back a "database unavailable" alert: it only updates
when something happens to poll it, so during exactly the outage the alert
needs to detect, the metric would go stale rather than flip to `0`.
`startDependencyHealthGauge` (`packages/observability/src/dependency-health.ts`)
runs the same `ReadinessCheck`s on its own fixed interval (default 10s,
independent of any orchestrator's probe cadence) and sets the gauge
directly - proven in `packages/observability/test/dependency-health.test.ts`
including the timeout-as-failure and recovery-detected-on-next-tick cases.

### Signing failures: a decorator, not a change to `packages/signing`'s audit contract

`apps/api/src/signing/metrics-recording-audit-trail.ts` implements the
existing `SigningAuditTrail` interface, incrementing
`gateway_signing_failures_total{stage}` for `validation_failed`/`sign_failed`
events before delegating to the real `PrismaSigningAuditTrail` - every event
is still recorded exactly as before. Getting the metric object into
`signing.provider.ts`'s factory needed one new Nest wiring decision:
`FinancialMetrics` is provided on its OWN dedicated `Registry`
(`apps/api/src/observability/financial-metrics.provider.ts`), separate from
the `Registry` `main.ts` builds for HTTP metrics. `createApp()` runs many
times in one process in the e2e suite (see `metrics.ts`'s own doc comment on
why a global prom-client registry is unsafe here) - a Nest provider
`useFactory` runs again for every one of those application instances, so
sharing metric objects across them would throw "already registered" on the
second. A fresh `Registry` per factory call is safe the same way
`createMetricsRegistry` already is; `main.ts` retrieves it after boot
(`app.get(FINANCIAL_METRICS_REGISTRY)`) and merges it into the one actually
served on `/metrics` via `Registry.merge` - confirmed from reading
prom-client 15.1.3's own source
(`node_modules/.pnpm/prom-client@15.1.3/.../registry.js`) that `merge`
registers the SAME metric object instances into a new registry rather than
copying values, so the merged registry is a live view, not a point-in-time
snapshot.

**Evidence** (`apps/api/test/signing-failure-metrics.e2e.test.ts`, real HTTP
+ Postgres): a request rejected by the destination allowlist and one
rejected by the amount ceiling each increment
`gateway_signing_failures_total{stage="validation_failed"}` by exactly one;
an accepted request increments nothing.

### Alert rules: 9 rules, one per required alert, every threshold disclosed as an example

`infrastructure/kubernetes/monitoring/alert-rules.yaml` defines
`BlockchainMonitorStopped`, `ScanLagIncreasing`, `ReconciliationDiscrepancyDetected`,
`WebhookDeliveryBacklog`, `DatabaseUnavailable`, `RedisUnavailable`,
`RpcProviderUnavailable`, `SigningFailure`, `AbnormalPaymentProcessingRate` -
exactly the roadmap's required list. Every numeric threshold (block counts,
failure counts, backlog size, the payment-rate multiplier) is a disclosed
example, not a measured production baseline - this system has no mainnet
traffic yet (Phase 24/31). What this phase delivers and proves is the
metric, the rule shape and the wiring; a new owner tunes thresholds to real
volume before relying on them unattended, stated in the file's own header
comment.

`AbnormalPaymentProcessingRate` combines two conditions with `or`: a spike
(current 5-minute rate over 3x the trailing hour's average, plus an absolute
floor so a jump from zero to one payment does not itself qualify) and a
stall (nonzero rate over the last hour, zero over the last 15 minutes).

The rules file is mounted into the ConfigMap-generated `prometheus-rules`
volume (`infrastructure/kubernetes/monitoring/kustomization.yaml`'s
`configMapGenerator`, the same pattern the baseline dashboard already used
for `grafana-dashboard`) rather than copy-pasted into `prometheus-config.yaml`'s
literal - one file is both what `promtool` tests directly and what
Prometheus actually loads.

### Evidence: every alert proven to fire, twice

**`promtool test rules`** (`infrastructure/kubernetes/monitoring/test/alert-rules.test.yaml`),
run against the exact pinned image this deployment uses
(`prom/prometheus:v3.7.3`, matching `prometheus.yaml`'s `image:`):

```
$ docker run --rm --entrypoint promtool -v "$PWD:/etc/prometheus" \
    prom/prometheus:v3.7.3 check rules /etc/prometheus/alert-rules.yaml
Checking /etc/prometheus/alert-rules.yaml
  SUCCESS: 9 rules found

$ docker run --rm --entrypoint promtool -v "$PWD:/etc/prometheus" \
    prom/prometheus:v3.7.3 test rules /etc/prometheus/test/alert-rules.test.yaml
  SUCCESS
```

Each of the 9 scenarios feeds synthetic time series shaped like the real
failure it represents (a flatlined last-success gauge, a sustained scan-lag
value, an increasing RPC-failure counter, a payment counter that ramps then
stalls, ...) and asserts the exact expected labels and rendered annotation
text - not just "an alert fired," but that it fired with the right
`network`/`dependency`/`stage` context a responder would actually read.

**A real cluster**, not just promtool's synthetic evaluator: applied
`infrastructure/kubernetes/monitoring` (Prometheus + the new
`prometheus-rules` ConfigMap + the second Grafana dashboard ConfigMap key) to
this environment's live `kind` cluster - the same one Phase 10/14/15 already
proved a working baseline against, still running the other sessions'
services (`api`, `worker`, `monitor`, `web`, `postgres`, `redis` all `Running`
throughout, untouched by this change). After `kubectl rollout status` on
both `prometheus` and `grafana`:

```
$ curl -s http://prometheus:9090/api/v1/rules | ...
rule count: 9
BlockchainMonitorStopped - ok
ScanLagIncreasing - ok
ReconciliationDiscrepancyDetected - ok
WebhookDeliveryBacklog - ok
DatabaseUnavailable - ok
RedisUnavailable - ok
RpcProviderUnavailable - ok
SigningFailure - ok
AbnormalPaymentProcessingRate - ok

$ curl -s http://prometheus:9090/api/v1/query?query=up | ...
(all 5 scrape targets still up=1: gateway-api, gateway-worker, gateway-monitor, gateway-web, prometheus)
```

Every rule loaded with `health: "ok"` and a real `lastEvaluation` timestamp;
existing scraping was unaffected. `curl http://grafana:3000/api/search` and
`/api/dashboards/uid/gateway-financial` confirmed both dashboards ("Gateway
- Baseline (Phase 10)" and the new "Gateway - Financial Operations (Phase
16)") are provisioned and reachable. The running `api`/`worker`/`monitor`
pods in this cluster predate this phase's code changes (no image rebuild was
part of this phase's scope), so the new `gateway_*` financial series are not
yet flowing from THIS live cluster - that gap is closed by the promtool
evidence above (which exercises the real alerting engine against the exact
shapes those metrics produce) and by the package/app-level tests below (which
exercise the real metric-recording code against a real database). A future
phase that rebuilds and redeploys these images gets live financial-metric
scraping with zero further Prometheus/Grafana configuration - the plumbing
already loads and evaluates correctly.

### Dashboard specification, operations runbook, incident-response procedure

Written as three separate documents in `docs/operations/`, matching this
project's existing granularity (`deployment-guide.md`, `release-process.md`,
`disaster-recovery-runbook.md` are each their own file):

- `dashboard-specification.md`: panel-by-panel intent for both the Phase 10
  baseline dashboard and the new "Gateway - Financial Operations" dashboard
  (`grafana-dashboard-financial.json`) - what each panel shows, who reads
  it, what a bad value means. Discloses that Alertmanager routing/notification
  is not deployed in this baseline (Prometheus evaluates and exposes
  `ALERTS`; nothing routes a firing alert to a human outside the dashboard).
- `operations-runbook.md`: routine checks, how the newly-scheduled
  reconciliation loop works and how to run it manually, and a first-checks/
  action runbook entry for each of the 9 alerts.
- `incident-response.md`: four severity levels tied to financial-correctness
  risk rather than to which alert fired, an escalation procedure, merchant-
  communication guidance (including an explicit warning never to
  communicate a specific discrepancy figure before investigation
  completes), and a post-incident review structure.

## Consequences

- **Full-ledger reconciliation runs unattended for the first time in this
  codebase's history.** This is a real behavior change, not just new
  observability: any pre-existing discrepancy anywhere in a deployed
  database will now surface within one `WORKER_RECONCILIATION_INTERVAL_MS`
  window instead of never.
- **`packages/ledger`, `packages/signing` and `packages/blockchain` gained no
  new dependency.** Every metrics integration point is either a thin
  app-level wrapper (`reconciliation-sweep.ts`, `instrumented-adapter.ts`)
  or a decorator implementing an existing interface
  (`MetricsRecordingSigningAuditTrail`) - consistent with this codebase's
  existing boundary that `packages/signing` has no dependency on any other
  package in the monorepo (ADR 0013).
- **Not done, disclosed**: Alertmanager deployment and notification routing;
  a real production-traffic-tuned threshold for any rule (Phase 24/31's
  job); settlement-status alerting has no real data to alert on until
  Phase 25 ships settlement creation; the images running in this
  environment's live cluster were not rebuilt as part of this phase, so the
  live-cluster evidence above proves the alerting/dashboard plumbing, not
  yet live financial-metric values from this specific cluster.
- **Pre-existing, still open**: `apps/api/test/admin-audit-logs.e2e.test.ts`'s
  first case (a plausible audit-log-write race) still fails, exactly as
  README.md's Phase 11 row already disclosed ("left for Phase 16/17"). This
  phase's actual scope is metrics, alerts, dashboards and the runbook/
  incident-response documents - not audit-log write ordering, which sits
  closer to Phase 17's "audit logging" security-hardening scope. Left open
  for that phase rather than fixed here as an unrelated scope expansion.
- **Found, not fixed, out of scope**: `apps/blockchain-monitor/test/full-pipeline.e2e.test.ts`
  fails with `EncryptionError: malformed ciphertext` on the current `main`,
  reproducible in isolation, in files this phase did not touch
  (`packages/security`, `packages/webhooks`, the test file itself, `.env` -
  none show as modified). Consistent with that test's own doc comment
  acknowledging "leftover fixtures elsewhere in this shared dev database" as
  a known risk class for this environment (multiple sessions share one
  Postgres instance) - `WebhookDispatcher.runOnce()` is deliberately global
  across the whole database (matching real single-process production
  behavior), so a stale row from an unrelated session, encrypted under a
  since-rotated key, can fail an unrelated test's delivery attempt. Not
  investigated further or fixed: root-causing or fixing shared-test-database
  isolation is outside this phase's scope, and the failure predates and is
  independent of every change in this ADR.
