import type { DatabaseClient } from '@gateway/database';
import { runLedgerReconciliation, type ReconciliationSummary } from '@gateway/ledger';
import type { FinancialMetrics } from '@gateway/observability';

/**
 * Runs one full-ledger reconciliation pass and records the outcome on
 * `metrics` (Phase 16/C6 exit criterion: "ledger reconciliation runs on a
 * schedule"). `runLedgerReconciliation` itself stays metrics-free
 * (`packages/ledger` has no observability dependency, by design) - this is
 * the thin, app-level wrapper `apps/worker/src/main.ts`'s poll loop calls
 * instead, exactly mirroring how `sweepExpiredInvoices` is wrapped by
 * `runExpirySweepLoop`.
 */
export async function runReconciliationSweep(db: DatabaseClient, metrics: FinancialMetrics): Promise<ReconciliationSummary> {
  const summary = await runLedgerReconciliation(db);
  if (summary.discrepancyCount > 0) {
    metrics.reconciliationDiscrepancies.inc({ kind: 'LEDGER_IMBALANCE' }, summary.discrepancyCount);
  }
  return summary;
}
