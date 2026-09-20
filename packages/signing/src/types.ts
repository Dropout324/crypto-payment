/**
 * Custodial signing (Mode A, ADR 0002) - not live. See this package's
 * `index.ts` and `docs/decisions/0013-signing-service.md` for what exists
 * here and, more importantly, what deliberately does not.
 */

/** A request to move funds out of a custodial wallet. Amount is the asset's smallest unit - a `bigint`, per ADR 0001, never a float. */
export interface SigningRequest {
  id: string;
  merchantId: string;
  network: string;
  asset: string;
  fromAddress: string;
  toAddress: string;
  amount: bigint;
  requestedBy: string;
  requestedAt: Date;
}

export interface SignedTransaction {
  requestId: string;
  rawTxHex: string;
  signedAt: Date;
}
