/**
 * Tracks spend for the rolling-window ceiling in `SigningPolicy`. Persisted
 * state is required in production - a restart resetting the window to zero
 * would silently defeat the ceiling it exists to enforce - so
 * `InMemorySpendTracker` (below) is a development/test default only, the
 * same posture `KeyProvider`/`SecretsProvider` take for their own seams.
 */
export interface SpendTracker {
  /** Total already spent by this merchant on this network within `windowSeconds` of `asOf`. */
  windowTotal(merchantId: string, network: string, windowSeconds: number, asOf: Date): Promise<bigint>;
  record(merchantId: string, network: string, amount: bigint, at: Date): Promise<void>;
}

interface SpendEntry {
  merchantId: string;
  network: string;
  amount: bigint;
  at: Date;
}

export class InMemorySpendTracker implements SpendTracker {
  private readonly entries: SpendEntry[] = [];

  async windowTotal(merchantId: string, network: string, windowSeconds: number, asOf: Date): Promise<bigint> {
    const cutoff = asOf.getTime() - windowSeconds * 1000;
    return this.entries
      .filter((entry) => entry.merchantId === merchantId && entry.network === network && entry.at.getTime() > cutoff)
      .reduce((sum, entry) => sum + entry.amount, 0n);
  }

  async record(merchantId: string, network: string, amount: bigint, at: Date): Promise<void> {
    this.entries.push({ merchantId, network, amount, at });
  }
}
