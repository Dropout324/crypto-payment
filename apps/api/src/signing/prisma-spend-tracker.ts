import type { SpendTracker } from '@gateway/signing';
import { newId } from '@gateway/shared';
import { decimalToUnits, unitsToDecimal, type DatabaseClient } from '@gateway/database';

/**
 * Durable `SpendTracker` (Phase 12: an in-memory rolling-window ceiling
 * "resets on every deploy" is not a ceiling - ADR 0013). Backed by its own
 * append-only `signing_spend_entries` table, independent of
 * `signing_approval_requests` - see that table's schema comment for why.
 */
export class PrismaSpendTracker implements SpendTracker {
  constructor(private readonly db: DatabaseClient) {}

  async windowTotal(merchantId: string, network: string, windowSeconds: number, asOf: Date): Promise<bigint> {
    const cutoff = new Date(asOf.getTime() - windowSeconds * 1000);
    const rows = await this.db.signingSpendEntry.findMany({
      where: { merchantId, network, occurredAt: { gt: cutoff, lte: asOf } },
      select: { amount: true },
    });
    return rows.reduce((sum, row) => sum + decimalToUnits(row.amount), 0n);
  }

  async record(merchantId: string, network: string, amount: bigint, at: Date): Promise<void> {
    await this.db.signingSpendEntry.create({
      data: { id: newId('signingSpendEntry'), merchantId, network, amount: unitsToDecimal(amount), occurredAt: at },
    });
  }
}
