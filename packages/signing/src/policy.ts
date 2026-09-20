/**
 * Per-network signing policy - the "policy controls (allowed destinations,
 * amount ceilings, rate limits, approvals)" ADR 0002 names as the
 * prerequisite for Mode A. One policy governs one network for one merchant
 * (or platform-wide, if the caller chooses not to key by merchant).
 */
export interface SigningPolicy {
  network: string;
  /** Lowercased destination addresses this policy allows signing a transfer to. Real checksum-aware comparison belongs to whichever `BlockchainAdapter` eventually wires this up - this package stays chain-agnostic. */
  allowedDestinations: ReadonlySet<string>;
  /** Smallest unit, matching `SigningRequest.amount`. */
  maxAmountPerTx: bigint;
  /** Smallest unit, summed over the trailing `windowSeconds`. */
  maxAmountPerWindow: bigint;
  windowSeconds: number;
  /** Distinct approvers required before a request signs. `1` means the requester's own submission is sufficient - no separate approval step. */
  requiredApprovals: number;
}
