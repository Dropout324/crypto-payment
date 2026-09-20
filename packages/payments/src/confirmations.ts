/**
 * Confirmation counting and reorg handling (SPEC sections 10, 11).
 *
 * The only definition of "confirmations" used anywhere in this system:
 *
 *     confirmations = chainTip - blockNumber + 1
 *
 * so a transaction in the tip block has 1 confirmation, not 0. Getting this
 * off by one means paying out a block early, every time.
 */

export interface ConfirmationInput {
  /** Block containing the transaction. */
  blockNumber: bigint;
  /** Highest block currently known on the canonical chain. */
  chainTip: bigint;
}

/**
 * Confirmations for a mined transaction. Returns 0 for a transaction that
 * claims a block ahead of the tip - which happens when a provider serves a
 * stale tip, and must never be read as "confirmed".
 */
export function countConfirmations({ blockNumber, chainTip }: ConfirmationInput): number {
  if (blockNumber <= 0n) throw new Error('blockNumber must be positive');
  if (chainTip < blockNumber) return 0;

  const confirmations = chainTip - blockNumber + 1n;
  // A confirmation count is bounded by the chain height; Number is safe here
  // and keeps the value comparable with the configured threshold.
  return confirmations > BigInt(Number.MAX_SAFE_INTEGER)
    ? Number.MAX_SAFE_INTEGER
    : Number(confirmations);
}

export function isConfirmed(confirmations: number, required: number): boolean {
  if (!Number.isInteger(required) || required < 1) {
    throw new Error(`required confirmations must be a positive integer, got ${required}`);
  }
  return confirmations >= required;
}

/**
 * Effective threshold for an invoice: the asset's floor, raised by a merchant
 * override if they asked for more.
 *
 * A merchant may raise the requirement but never lower it - lowering it is the
 * merchant trading OUR risk for their convenience.
 */
export function effectiveConfirmations(assetDefault: number, merchantOverride?: number): number {
  if (merchantOverride === undefined) return assetDefault;
  if (!Number.isInteger(merchantOverride) || merchantOverride < 1) {
    throw new Error(`confirmation override must be a positive integer, got ${merchantOverride}`);
  }
  return Math.max(assetDefault, merchantOverride);
}

/** Progress for the customer-facing "3 / 12" display. */
export function confirmationProgress(
  confirmations: number,
  required: number,
): { current: number; required: number; percent: number; complete: boolean } {
  const current = Math.max(0, Math.min(confirmations, required));
  return {
    current,
    required,
    percent: required === 0 ? 100 : Math.floor((current / required) * 100),
    complete: confirmations >= required,
  };
}

// ---------------------------------------------------------------------------
// Reorg detection
// ---------------------------------------------------------------------------

export interface ReorgCheckInput {
  /** Block hash we recorded when we processed this height. */
  storedBlockHash: string;
  /** Block hash the chain reports for that height NOW. */
  currentBlockHash: string | null;
}

export const ReorgVerdict = {
  /** The chain still agrees with what we stored. */
  INTACT: 'INTACT',
  /** The block at that height changed: our record is on an orphaned branch. */
  REORGED: 'REORGED',
  /** The height no longer exists; the chain is shorter than we thought. */
  MISSING: 'MISSING',
} as const;

export type ReorgVerdictValue = (typeof ReorgVerdict)[keyof typeof ReorgVerdict];

export function detectReorg({ storedBlockHash, currentBlockHash }: ReorgCheckInput): ReorgVerdictValue {
  if (currentBlockHash === null) return ReorgVerdict.MISSING;
  // Hashes are compared case-insensitively: providers differ on 0x-prefix casing.
  return storedBlockHash.toLowerCase() === currentBlockHash.toLowerCase()
    ? ReorgVerdict.INTACT
    : ReorgVerdict.REORGED;
}

/**
 * Whether a block is still inside the window where a reorg can reach it.
 * Blocks at or beyond this depth are treated as settled and are not re-checked
 * on every pass - otherwise the monitor re-reads the whole chain forever.
 */
export function isWithinReorgWindow(
  blockNumber: bigint,
  chainTip: bigint,
  reorgDepth: number,
): boolean {
  if (reorgDepth < 0) throw new Error('reorgDepth must not be negative');
  return chainTip - blockNumber < BigInt(reorgDepth);
}

/**
 * The block a monitor should resume from after a reorg: `reorgDepth` blocks
 * behind the tip, never below block 1, and never ahead of where we already
 * were. Re-processing is safe because crediting is idempotent; skipping is not.
 */
export function reorgRewindTarget(
  lastProcessed: bigint,
  chainTip: bigint,
  reorgDepth: number,
): bigint {
  const target = chainTip - BigInt(reorgDepth);
  const floor = target < 1n ? 1n : target;
  return floor < lastProcessed ? floor : lastProcessed;
}
