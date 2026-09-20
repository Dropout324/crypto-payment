# Operations runbook

Phase 16 (C6, `README.md#roadmap`), ADR 0030. Day-to-day
operating procedures for someone who did not build this system: what to
check routinely, what each alert in
[`infrastructure/kubernetes/monitoring/alert-rules.yaml`](../../infrastructure/kubernetes/monitoring/alert-rules.yaml)
means mechanically and what to do first, and how to run the recurring
maintenance job this phase found was never actually scheduled.

This is not the disaster-recovery runbook (`disaster-recovery-runbook.md`,
Phase 14) - that covers destroyed/corrupted state and full-environment loss.
This covers the routine and the "something is wrong but nothing is
destroyed" cases. It is also not the incident-response **process**
(severity levels, escalation, merchant communication, post-incident review)
- that is `incident-response.md`, this same phase.

## Routine checks (start of shift / daily)

1. Open both Grafana dashboards (`dashboard-specification.md` covers every
   panel): "Gateway - Baseline" for scrape/HTTP/loop health, "Gateway -
   Financial Operations" for the panels this phase added.
2. Check the "Active alerts" table (panel 11 on the financial dashboard, or
   `curl http://prometheus:9090/api/v1/alerts`) - anything firing should
   already have paged if Alertmanager routing is configured (see
   `dashboard-specification.md`'s disclosed gap); if not, this is the
   fallback way to notice.
3. Confirm the ledger reconciliation loop actually ran in the last
   scheduled interval: `gateway_worker_last_success_timestamp_seconds{loop="reconciliation"}`
   should be within `WORKER_RECONCILIATION_INTERVAL_MS` (default 1 hour) of
   now. If it is not, the worker's reconciliation loop has stalled - check
   `apps/worker`'s logs for `{loop: "reconciliation"}` tick failures.
4. `gateway_reconciliation_open_discrepancies` should read `0`. Any other
   value is an open financial discrepancy - see the `ReconciliationDiscrepancyDetected`
   procedure below; do not wait for the next routine check to act on it.

## Ledger reconciliation - how it actually runs

Found during this phase's audit: `runLedgerReconciliation`
(`packages/ledger`) was implemented and unit-tested but never called by any
application - reconciliation never ran automatically. Fixed:
`apps/worker/src/reconciliation-sweep.ts` wraps it and
`apps/worker/src/main.ts` runs it as a fourth poll loop
(`WORKER_RECONCILIATION_INTERVAL_MS`, default `3600000` = 1 hour), alongside
the existing webhook-dispatch and expiry-sweep loops. Every run:

- Reconciles every active ledger account (the whole ledger, not scoped to
  one merchant - matches what a scheduled production job should do).
- Records one `ReconciliationRun` row and a `ReconciliationDiscrepancy` row
  per mismatch, exactly as `runLedgerReconciliation` always did - this phase
  changed nothing about that logic, only that it now runs unattended.
- Increments `gateway_reconciliation_discrepancies_total{kind="LEDGER_IMBALANCE"}`
  for real evidence a monitoring rule can fire against - see
  `apps/worker/test/reconciliation-sweep.test.ts` for the test that
  deliberately corrupts a `ledger_accounts.cached_balance` row and proves
  the scheduled sweep catches it.

To run it manually (e.g. to reconcile immediately after a suspicious event,
without waiting for the next scheduled tick): call `runLedgerReconciliation`
directly from a one-off script or `node -e`, the same way
`scripts/kubernetes/dr-verify.cjs` already does for disaster-recovery
verification - there is no separate CLI wrapper, by design, since the
scheduled loop is the only path that needs to exist for normal operation.

## Alert runbook

Every alert below is defined in `alert-rules.yaml` and was proven to
actually fire - both via `promtool test rules`
(`infrastructure/kubernetes/monitoring/test/alert-rules.test.yaml`) and live
in a real cluster (ADR 0030). Thresholds in `alert-rules.yaml` are disclosed
examples pending real production traffic (Phase 24/31) - tune them to actual
volume before relying on them unattended.

### BlockchainMonitorStopped (critical)

**Meaning**: a network's scan loop has not completed a tick in over 5
minutes. **First checks**: `kubectl -n gateway logs deployment/monitor
--tail=100`; is the pod even running (`kubectl -n gateway get pods`)? Is the
configured RPC URL for that network reachable from inside the cluster?
**Action**: if the pod crashed, Kubernetes should already be restarting it -
if it is stuck in a crash loop, the logs will show why. If the RPC provider
is down, see `disaster-recovery-runbook.md`'s Scenario 4.

### ScanLagIncreasing (warning)

**Meaning**: a network's monitor is falling behind the chain tip.
**First checks**: `gateway_monitor_tick_duration_seconds` for that
network - is each tick taking longer than the poll interval? Is the RPC
provider rate-limiting or slow? **Action**: usually resolves once RPC
latency normalises; if sustained, check `MONITOR_BLOCK_BATCH_SIZE` is not
set too high for the provider's rate limit (ADR 0010).

### ReconciliationDiscrepancyDetected (critical)

**Meaning**: a real, unresolved mismatch between the ledger's cached
balance and its ground-truth entry history, OR an orphaned credit from a
chain reorg (`gateway_reconciliation_discrepancies_total{kind}`
distinguishes `LEDGER_IMBALANCE` from `ORPHANED_CREDIT`). **This is never
auto-corrected - per SPEC section 21, it is not this alert's job to guess
the fix.** **First checks**: `GET /v1/admin/reconciliation-discrepancies`
for full detail (expected vs. actual value, subject id). **Action**: this is
a financial-integrity incident - follow `incident-response.md`'s severity
classification (this always qualifies at minimum as Sev2) before resolving
anything through `POST /v1/admin/reconciliation-discrepancies/:id/resolve`.

### WebhookDeliveryBacklog (warning)

**Meaning**: more than the example threshold of webhook deliveries are
`PENDING` or awaiting retry. **First checks**:
`gateway_webhook_delivery_failures_total{outcome}` - is this one merchant's
endpoint down (concentrated `failed`/`exhausted`), or is the whole worker
falling behind (broad `PENDING` growth with low failure counts)? **Action**:
for one bad endpoint, nothing to do - the existing auto-disable-after-N-failures
behavior (`WEBHOOK_DISABLE_AFTER_CONSECUTIVE_FAILURES`) already contains it.
For broad backlog growth, check the worker pod's resource usage and
`WORKER_WEBHOOK_BATCH_SIZE`/`WORKER_WEBHOOK_POLL_INTERVAL_MS`.

### DatabaseUnavailable / RedisUnavailable (critical)

**Meaning**: the named service's own periodic check
(`gateway_dependency_up{dependency,service}`) just failed - this is
independent of and faster than waiting for a `/ready` probe to be polled.
**First checks**: `kubectl -n gateway get pods` for `postgres`/`redis`;
connection limits (`pg_stat_activity` count vs. `max_connections`).
**Action**: see `disaster-recovery-runbook.md`'s Scenario 1 (PostgreSQL) or
Scenario 3 (Redis) if the service itself is actually down, not just
temporarily unreachable from one pod.

### RpcProviderUnavailable (critical)

**Meaning**: a network's RPC provider is failing calls to a specific method
(`gateway_monitor_rpc_failures_total{network,method}` - `instrumentAdapter`,
`apps/blockchain-monitor`, wraps every adapter call). **First checks**: the
provider's own status page; whether both `*_RPC_URL` and
`*_RPC_FALLBACK_URL` are affected or just the primary. **Action**: see
`disaster-recovery-runbook.md`'s Scenario 4.

### SigningFailure (critical)

**Meaning**: a signing request passed policy validation (destination
allowlist, amount ceilings) but the backend itself failed
(`gateway_signing_failures_total{stage="sign_failed"}` -
`MetricsRecordingSigningAuditTrail`, `apps/api`). A `validation_failed`
event is expected occasionally (a real policy rejection) and does not alert
on its own - only `sign_failed` does. **First checks**: `audit_logs` where
`resource_type = 'signing_request'` for the full failure reason.
**Action**: since Mode A (custodial signing) is not live in production
(ADR 0026), this should never fire outside the emulated-HSM staging
backend - treat any occurrence as worth investigating immediately.

### AbnormalPaymentProcessingRate (warning)

**Meaning**: `gateway_payments_processed_total`'s rate either spiked to 3x+
the last hour's average, or stalled to zero after sustained processing.
**First checks**: for a spike, check for abuse or a merchant integration
bug generating duplicate invoices; for a stall, check whether
`BlockchainMonitorStopped` or a worker issue is also firing - a stall is
often a symptom of one of those, not an independent root cause.

## Routine maintenance

- **Webhook endpoint re-enabling**: an endpoint auto-disabled after
  consecutive failures needs a merchant/operator action to re-enable via
  the dashboard or API - this is not automatic and is not a bug.
- **Reconciliation interval tuning**: `WORKER_RECONCILIATION_INTERVAL_MS`
  trades detection speed against load (a full-ledger recompute touches every
  active account). The 1-hour default is a starting point, not a measured
  production value - see Phase 28 for capacity guidance once it exists.
