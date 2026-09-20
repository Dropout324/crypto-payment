# Incident response procedure

Phase 16 (C6, `README.md#roadmap`), ADR 0030. Severity
levels, escalation, merchant communication and post-incident review for
someone who did not build this system. This is the process layer that sits
above the mechanics: `operations-runbook.md` says what to check for a given
alert; `disaster-recovery-runbook.md` says how to actually recover destroyed
or corrupted state. This document says how humans coordinate while either of
those is happening.

There is no on-call rotation, paging service or dedicated incident-response
tooling (PagerDuty, Opsgenie, a status page) deployed with this system - a
new owner builds that organisational layer on top of this process. What
follows is deliberately tooling-independent so it survives whatever the new
owner chooses.

## Severity levels

| Severity | Definition | Examples from this system |
|---|---|---|
| **Sev1 - Critical** | Financial correctness is at risk, or the system cannot process payments at all. | `ReconciliationDiscrepancyDetected` with a nonzero `LEDGER_IMBALANCE`; `DatabaseUnavailable`; every blockchain monitor network down simultaneously (`BlockchainMonitorStopped` firing for every configured network); a confirmed double-credit (should be structurally impossible per the `UNIQUE(network, tx_hash, transfer_index)` constraint - if this alarm has any signal at all, it is Sev1). |
| **Sev2 - High** | A subset of payment processing is degraded or a single financial-integrity signal fired, but the system as a whole is still operating. | `ReconciliationDiscrepancyDetected` with an `ORPHANED_CREDIT` (a reorg case SPEC section 21 already routes to manual review, not a silent loss); `RpcProviderUnavailable` for one network with others still healthy; `SigningFailure`. |
| **Sev3 - Medium** | Operational degradation with no immediate financial-correctness risk. | `WebhookDeliveryBacklog`; `ScanLagIncreasing`; `RedisUnavailable` (rate limiting degraded, but no financial data path depends on Redis - see `disaster-recovery-runbook.md` Scenario 3). |
| **Sev4 - Low** | Noise, a known/accepted limitation surfacing, or a false positive needing threshold tuning. | `AbnormalPaymentProcessingRate` firing on legitimate traffic growth; any alert whose threshold clearly needs adjustment for this deployment's actual volume. |

Severity is assigned by the responder based on **actual observed impact**,
not by which alert fired - the table above is a starting classification, not
a substitute for judgment. A `Sev3` alert that turns out to correlate with a
real ledger discrepancy is reclassified to `Sev1` immediately, not left at
its initial label.

## Escalation

1. **Detection**: an alert fires (`alert-rules.yaml`, surfaced via
   Prometheus's `/api/v1/alerts` and the "Active alerts" panel - see
   `dashboard-specification.md`'s disclosed gap: no Alertmanager routing is
   deployed in this baseline, so detection today is "someone is watching the
   dashboard" or "someone wires Alertmanager notifications" - not automatic
   paging).
2. **Acknowledge and classify**: the responder assigns a severity from the
   table above within the time the new owner's own SLA requires (not
   specified here - this system has no support-tier commitments of its own
   to inherit).
3. **Sev1/Sev2**: escalate to whoever the new owner designates as the
   financial-incident owner (this system has no named role for that - it is
   organisational, not code). Do not resolve a reconciliation discrepancy or
   take any action that changes ledger state without that person's
   awareness, per the "never silently corrected" invariant.
4. **Sev3/Sev4**: the responder handles it directly using
   `operations-runbook.md`, escalating only if it does not resolve within a
   reasonable time or reveals a bigger problem than it first appeared.

## Merchant communication

- **A merchant's payment is affected** (their specific invoice is stuck, or
  their webhook deliveries are backed up): communicate directly once the
  cause is understood, even before full resolution - "we are aware, here is
  the current state" is better than a merchant discovering it from their own
  monitoring first.
- **A systemic incident** (any Sev1, or a Sev2 affecting more than one
  merchant): the new owner determines whether and how to notify all
  merchants - this system has no status-page or broadcast-notification
  mechanism built in. `apps/worker`'s webhook delivery itself is the only
  merchant-facing notification channel that exists in the codebase, and it
  is not appropriate for incident communication (it is for payment events,
  not operational status).
- **Never communicate a specific dollar/ledger-unit figure for an open
  reconciliation discrepancy before it is fully investigated** - the
  `expected_value`/`actual_value` on a `ReconciliationDiscrepancy` row is
  what the mismatch measured, not necessarily what actually happened
  financially (e.g. an `ORPHANED_CREDIT` from a reorg may still resolve to
  zero real loss once the chain re-confirms).

## Post-incident review

For every Sev1 and Sev2 incident:

1. **Timeline**: when the alert fired, when it was acknowledged, when root
   cause was identified, when resolved - pull the `for:` duration and
   `lastEvaluation`/`activeAt` fields from Prometheus's `/api/v1/alerts` (or
   `/api/v1/rules`) while they are still available; they age out with
   Prometheus's retention (`--storage.tsdb.retention.time=6h` in this
   baseline - see `infrastructure/kubernetes/monitoring/prometheus.yaml`,
   which a new owner should raise for production).
2. **Root cause**: the actual mechanism, not just "RPC was down" - trace it
   to a specific code path, configuration value, or external dependency.
3. **Financial impact, if any**: for a `ReconciliationDiscrepancyDetected`
   incident specifically, the resolution recorded via
   `POST /v1/admin/reconciliation-discrepancies/:id/resolve` (its
   `resolution_note`) is the durable record of what was found and how it
   was closed - reference it here rather than duplicating it.
4. **What would have caught this sooner**: a missing metric, a threshold
   that was too loose, a runbook step that did not exist - feed this back
   into `alert-rules.yaml`, `operations-runbook.md`, or this document
   directly. Every alert in this system's current set exists because a
   specific failure mode was identified during Phase 16's audit
   (`README.md#roadmap`'s Phase 16 Starting Point); this
   is how that set is meant to keep growing.
5. **Action items**: concrete, owned, with a target date - not "investigate
   further" with no owner.

No template repository or ticketing-system integration is prescribed here -
this procedure describes what a review must produce, not which tool
produces it.
