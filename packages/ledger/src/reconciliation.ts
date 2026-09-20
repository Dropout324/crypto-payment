import { newId } from '@gateway/shared';
import { type DatabaseClient, type TransactionClient, decimalToUnits, runInTransaction, unitsToDecimal } from '@gateway/database';
import { computeAccountBalance, computeBalanceDelta } from './balances.js';

/**
 * Ledger reconciliation (SPEC section 21).
 *
 * A mismatch between the ground truth (summed `ledger_entries`) and the
 * read-optimised `cached_balance` is NEVER auto-corrected here - it is
 * recorded as a `RECONCILIATION_REQUIRED`-grade discrepancy for a human to
 * resolve, per SPEC section 21's explicit prohibition on silent correction.
 *
 * The comparison is INCREMENTAL, not "cached vs. full recompute" directly:
 * new entries arriving since the last reconciliation are the routine case,
 * not a discrepancy, so what is actually checked is whether
 * `cached_balance + (sum of entries after cached_through_seq)` agrees with a
 * full ground-truth recompute. Those two are mathematically guaranteed to
 * agree unless something outside normal posting altered the cache or the
 * entry history - which is precisely the class of problem this function
 * exists to catch.
 */

export interface AccountReconciliationResult {
  accountId: string;
  matched: boolean;
  /** What the cache says now, advanced by the entries posted since the last run. */
  refreshedUnits: bigint;
  /** Ground truth: a full recompute from every entry the account has ever had. */
  computedUnits: bigint;
}

export async function reconcileAccount(
  tx: TransactionClient,
  accountId: string,
): Promise<AccountReconciliationResult> {
  const account = await tx.ledgerAccount.findUniqueOrThrow({ where: { id: accountId } });
  const cachedUnits = decimalToUnits(account.cachedBalance);

  const { delta, throughSequence } = await computeBalanceDelta(tx, accountId, account.cachedThroughSeq);
  const refreshedUnits = cachedUnits + delta;

  const computed = await computeAccountBalance(tx, accountId);
  const matched = refreshedUnits === computed.units;

  if (matched) {
    // Safe to persist the refresh: it was independently confirmed against a
    // full recompute in this same pass, not merely assumed correct.
    await tx.ledgerAccount.update({
      where: { id: accountId },
      data: { cachedBalance: unitsToDecimal(refreshedUnits), cachedBalanceAt: new Date(), cachedThroughSeq: throughSequence },
    });
  }

  return { accountId, matched, refreshedUnits, computedUnits: computed.units };
}

export interface ReconciliationSummary {
  runId: string;
  status: 'CLEAN' | 'DISCREPANCIES_FOUND';
  checkedCount: number;
  discrepancyCount: number;
}

export interface RunLedgerReconciliationOptions {
  /** Limit to accounts for one merchant; omit to reconcile the whole ledger. */
  merchantId?: string;
}

/**
 * Reconciles every active ledger account, recording one `ReconciliationRun`
 * and a `ReconciliationDiscrepancy` row per mismatch found. Never throws for
 * a discrepancy - a mismatch is an expected, handled outcome that the run
 * reports, not a failure of the run itself.
 */
export async function runLedgerReconciliation(
  db: DatabaseClient,
  options: RunLedgerReconciliationOptions = {},
): Promise<ReconciliationSummary> {
  const runId = newId('reconciliation');
  const periodStart = new Date();

  await db.reconciliationRun.create({
    data: {
      id: runId,
      scope: 'ledger_balance',
      status: 'RUNNING',
      periodStart,
      periodEnd: periodStart,
    },
  });

  const accounts = await db.ledgerAccount.findMany({
    where: { isActive: true, ...(options.merchantId ? { merchantId: options.merchantId } : {}) },
    select: { id: true },
  });

  let discrepancyCount = 0;

  for (const { id: accountId } of accounts) {
    const result = await runInTransaction(db, (tx) => reconcileAccount(tx, accountId));

    if (!result.matched) {
      discrepancyCount += 1;
      await db.reconciliationDiscrepancy.create({
        data: {
          id: newId('reconciliation'),
          runId,
          kind: 'LEDGER_IMBALANCE',
          severity: 'CRITICAL',
          subjectType: 'ledger_account',
          subjectId: accountId,
          expectedValue: result.refreshedUnits.toString(),
          actualValue: result.computedUnits.toString(),
          details: { refreshedUnits: result.refreshedUnits.toString(), computedUnits: result.computedUnits.toString() },
        },
      });
    }
  }

  const status = discrepancyCount === 0 ? 'CLEAN' : 'DISCREPANCIES_FOUND';
  await db.reconciliationRun.update({
    where: { id: runId },
    data: {
      status,
      checkedCount: accounts.length,
      discrepancyCount,
      periodEnd: new Date(),
      completedAt: new Date(),
    },
  });

  return { runId, status, checkedCount: accounts.length, discrepancyCount };
}
