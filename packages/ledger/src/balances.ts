import { Money } from '@gateway/shared';
import { type TransactionClient, debitIncreases, decimalToUnits } from '@gateway/database';

/**
 * Balance computation (SPEC section 20: "never calculate balances by simply
 * trusting a mutable balance field").
 *
 * The ONLY correct way to know an account's balance is to sum its
 * `ledger_entries`. `ledger_accounts.cached_balance` exists purely as a
 * read-optimisation that `reconciliation.ts` refreshes and cross-checks; it
 * is never the value returned here.
 */

export interface ComputedBalance {
  accountId: string;
  /** Signed: positive means a normal balance on the debit side for this account type. */
  units: bigint;
  assetSymbol: string;
  assetDecimals: number;
  /** Highest ledger_entries.sequence folded into this sum, for cache bookkeeping. */
  throughSequence: bigint | null;
  entryCount: number;
}

export async function computeAccountBalance(tx: TransactionClient, accountId: string): Promise<ComputedBalance> {
  const account = await tx.ledgerAccount.findUniqueOrThrow({ where: { id: accountId } });
  const normalIsDebit = debitIncreases(account.type);

  const entries = await tx.ledgerEntry.findMany({
    where: { accountId },
    orderBy: { sequence: 'asc' },
    select: { direction: true, amount: true, sequence: true },
  });

  let units = 0n;
  let throughSequence: bigint | null = null;

  for (const entry of entries) {
    const amount = decimalToUnits(entry.amount);
    const matchesNormalSide = (entry.direction === 'DEBIT') === normalIsDebit;
    units += matchesNormalSide ? amount : -amount;
    throughSequence = entry.sequence;
  }

  return {
    accountId,
    units,
    assetSymbol: account.assetSymbol,
    assetDecimals: account.assetDecimals,
    throughSequence,
    entryCount: entries.length,
  };
}

export function toMoney(balance: ComputedBalance): Money {
  return Money.fromUnits(balance.units, balance.assetSymbol, balance.assetDecimals);
}

/**
 * Sum of only the entries strictly after `sinceSequence` (all of them when
 * `sinceSequence` is null). Used to advance the cache incrementally instead
 * of re-summing an account's entire history on every reconciliation pass.
 */
export async function computeBalanceDelta(
  tx: TransactionClient,
  accountId: string,
  sinceSequence: bigint | null,
): Promise<{ delta: bigint; throughSequence: bigint | null }> {
  const account = await tx.ledgerAccount.findUniqueOrThrow({ where: { id: accountId } });
  const normalIsDebit = debitIncreases(account.type);

  const entries = await tx.ledgerEntry.findMany({
    where: { accountId, ...(sinceSequence !== null ? { sequence: { gt: sinceSequence } } : {}) },
    orderBy: { sequence: 'asc' },
    select: { direction: true, amount: true, sequence: true },
  });

  let delta = 0n;
  let throughSequence = sinceSequence;

  for (const entry of entries) {
    const amount = decimalToUnits(entry.amount);
    const matchesNormalSide = (entry.direction === 'DEBIT') === normalIsDebit;
    delta += matchesNormalSide ? amount : -amount;
    throughSequence = entry.sequence;
  }

  return { delta, throughSequence };
}
