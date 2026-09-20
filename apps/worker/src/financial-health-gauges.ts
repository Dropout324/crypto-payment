import type { DatabaseClient } from '@gateway/database';
import type { FinancialMetrics } from '@gateway/observability';

/**
 * Re-samples the gauges that back three of Phase 16/C6's alerts: webhook
 * delivery backlog, settlements stuck in a bad state, and reconciliation
 * discrepancies still awaiting resolution. Each is a cheap `COUNT`/`GROUP BY`
 * over an indexed column, safe to run frequently - unlike full reconciliation
 * (`reconciliation-sweep.ts`), nothing here recomputes a balance.
 *
 * `settlementsByStatus` is honest about a real gap this phase's audit found:
 * no code path in this codebase creates a `Settlement` row yet (fee
 * collection is Phase 25's job - see the README and ADR 0025's disclosure).
 * The gauge and its alert are wired now so they activate the moment Phase 25
 * starts producing settlements, with no further observability work; until
 * then it correctly reports zero everywhere.
 */
export async function collectFinancialHealthGauges(db: DatabaseClient, metrics: FinancialMetrics): Promise<void> {
  const [backlog, settlementCounts, openDiscrepancies] = await Promise.all([
    db.webhookDelivery.groupBy({ by: ['status'], _count: { _all: true }, where: { status: { in: ['PENDING', 'FAILED'] } } }),
    db.settlement.groupBy({ by: ['status'], _count: { _all: true } }),
    db.reconciliationDiscrepancy.count({ where: { resolvedAt: null } }),
  ]);

  // Zero every previously-seen status label before applying the fresh counts,
  // so a status that had a backlog last tick and none now reads 0, not stale.
  for (const status of ['PENDING', 'FAILED'] as const) metrics.webhookBacklog.set({ status }, 0);
  for (const row of backlog) metrics.webhookBacklog.set({ status: row.status }, row._count._all);

  const allSettlementStatuses = ['SCHEDULED', 'PENDING_APPROVAL', 'PROCESSING', 'BROADCAST', 'COMPLETED', 'FAILED', 'CANCELLED'] as const;
  for (const status of allSettlementStatuses) metrics.settlementsByStatus.set({ status }, 0);
  for (const row of settlementCounts) metrics.settlementsByStatus.set({ status: row.status }, row._count._all);

  metrics.reconciliationOpenDiscrepancies.set(openDiscrepancies);
}
