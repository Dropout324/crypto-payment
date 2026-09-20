# Dashboard specification

Phase 16 (C6, `README.md#roadmap`), ADR 0030. This is the
docs-driven specification the roadmap asks for - distinct from the single
baseline dashboard Phase 10 provisioned and proved renders real data
(`infrastructure/kubernetes/monitoring/grafana-dashboard.json`, "Gateway -
Baseline (Phase 10)"). Phase 16 adds a second, financial-operations
dashboard (`grafana-dashboard-financial.json`, "Gateway - Financial
Operations (Phase 16)") and this document, which specifies the intent behind
every panel on both - what it shows, who reads it, and what a bad value
means - so a new owner can extend or rebuild either dashboard without
guessing why a panel exists.

Both dashboards are provisioned automatically by
[`infrastructure/kubernetes/monitoring/grafana.yaml`](../../infrastructure/kubernetes/monitoring/grafana.yaml)
via the `grafana-dashboard` ConfigMap
(`infrastructure/kubernetes/monitoring/kustomization.yaml`'s
`configMapGenerator`) - `kubectl apply -k infrastructure/kubernetes/monitoring`
is the only step needed to see them in a running Grafana. Verified live
against a real `kind` cluster during this phase: both dashboards appear in
Grafana's own `/api/search` and resolve by UID
(`gateway-baseline`, `gateway-financial`) - see ADR 0030 for the transcript.

## Audience

- **On-call engineer**: the financial dashboard's top row (dependency
  health) and the alert table are the first two things to check when paged.
- **Operator/support**: the payment-latency and webhook-backlog panels
  answer "is a specific merchant's payment stuck, and where."
- **A new owner doing due diligence**: both dashboards, read together with
  `infrastructure/kubernetes/monitoring/alert-rules.yaml`, are the honest
  answer to "what does this system's operator actually see."

## Gateway - Baseline (Phase 10)

Unchanged by this phase - see the Phase 10 row in
`README.md#roadmap` for its own evidence. Kept here only
as context for what NOT to duplicate:

| Panel | Reads |
|---|---|
| Scrape targets up | `up{job=~"gateway-.*"}` |
| HTTP request rate | `gateway_http_requests_total` |
| HTTP 5xx rate | `gateway_http_requests_total{status_code=~"5.."}` |
| HTTP p95 latency | `gateway_http_request_duration_seconds_bucket` |
| Worker: seconds since last successful tick | `gateway_worker_last_success_timestamp_seconds` |
| Monitor: scan lag | `gateway_monitor_scan_lag_blocks` |
| Poll-loop tick errors | `gateway_worker_tick_errors_total`, `gateway_monitor_tick_errors_total` |

## Gateway - Financial Operations (Phase 16)

Every panel reads a metric this phase introduced (see ADR 0030 for where
each is recorded) or `ALERTS`, Prometheus's own built-in series for rules
that are currently firing.

| # | Panel | Type | Reads | What a bad value means |
|---|---|---|---|---|
| 1 | Dependency health (database, Redis) | stat | `gateway_dependency_up{dependency,service}` | `0` for any `service`/`dependency` pair means that process's own periodic check (`startDependencyHealthGauge`, `packages/observability`) just failed - independent of whether anything is actively calling `/ready` right now. Backs `DatabaseUnavailable`/`RedisUnavailable`. |
| 2 | Webhook delivery failures (rate, by outcome) | timeseries | `gateway_webhook_delivery_failures_total{outcome}` | A rising `failed` rate means merchant endpoints are erroring but retries are still scheduled; a rising `exhausted` rate means deliveries are being given up on - the merchant is not hearing about their own payments. |
| 3 | Webhook delivery backlog (by status) | timeseries | `gateway_webhook_backlog{status}` | Sustained growth in `PENDING` means the worker's webhook loop cannot keep up with volume; growth in `FAILED` means endpoints are down and retries are queuing. Backs `WebhookDeliveryBacklog`. |
| 4 | Payment detection latency | timeseries (p50/p95) | `gateway_payment_detection_latency_seconds` | Time from invoice creation to the first matching on-chain transfer being sighted. A rising p95 with `ScanLagIncreasing` quiet usually points at low transaction volume or a slow customer, not a system fault; rising together with scan lag points at the monitor. |
| 5 | Payment confirmation latency | timeseries (p50/p95) | `gateway_payment_confirmation_latency_seconds` | Time from first sighting to a confirmed, final payment outcome. Should track each network's `requiredConfirmations x block time`; a sustained rise with no chain congestion suggests a stuck `updateConfirmations` loop. |
| 6 | Payments processed (rate) | timeseries | `gateway_payments_processed_total` | The volume signal behind `AbnormalPaymentProcessingRate` - a sudden spike or an unexplained drop to zero is the thing that alert watches for. |
| 7 | Settlements by status | timeseries | `gateway_settlements_by_status{status}` | **Honest gap, disclosed**: no code path creates a `Settlement` row yet (fee collection is Phase 25's job) - this panel and its `FAILED` alert threshold are wired now so they activate the moment Phase 25 ships, with zero further observability work. Today it correctly reads zero everywhere. |
| 8 | Reconciliation discrepancies (recorded rate + still open) | timeseries | `gateway_reconciliation_discrepancies_total{kind}`, `gateway_reconciliation_open_discrepancies` | ANY non-zero value here is a real, unresolved financial discrepancy per SPEC section 21 (never auto-corrected) - this is the single most important panel on this dashboard. Backs `ReconciliationDiscrepancyDetected`. |
| 9 | RPC failures (rate, by network + method) | timeseries | `gateway_monitor_rpc_failures_total{network,method}` | Sustained failures on one `method` (e.g. `getCurrentBlock`) point at that call specifically, not a full provider outage - check the provider's status page and the configured fallback URL (ADR 0025). Backs `RpcProviderUnavailable`. |
| 10 | Signing failures (rate, by stage) | timeseries | `gateway_signing_failures_total{stage}` | `validation_failed` means a request was correctly rejected by policy (allowlist/ceiling) - expected occasionally, not itself an incident. `sign_failed` means the backend itself threw - always worth investigating; backs `SigningFailure`. |
| 11 | Active alerts | table | `ALERTS{alertstate="firing"}` | A live view of every currently-firing rule from `alert-rules.yaml`, without needing a separate Alertmanager UI open. |

## What this specification deliberately does not cover

- **Alertmanager routing/notification channels** (Slack, PagerDuty, email):
  not deployed in this baseline - `alert-rules.yaml` defines rules
  Prometheus evaluates and exposes on `ALERTS`/`/api/v1/alerts`, proven live
  in ADR 0030, but nothing here routes a firing alert to a human outside
  this dashboard. A new owner wires an `Alertmanager` deployment and a
  `alerting:` block in `prometheus.yml` pointing at it - the rules
  themselves do not change.
- **Capacity/throughput dashboards** (requests/sec at scale, replica
  sizing): Phase 28's job, not this one's.
- **Log-based panels**: this baseline has no log aggregation backend
  (Loki, etc.) provisioned; `gateway_*` metrics are the only data source
  either dashboard reads.
