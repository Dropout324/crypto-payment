/**
 * Transfer matching decision logic (SPEC section 11).
 *
 * Pure and database-free by design, matching the rest of this package: the
 * monitor gathers the facts (does an asset exist for this contract, is there
 * an invoice, has this transfer already been credited...) and hands them
 * here as a plain input. That keeps every one of the ten SPEC-11 checks
 * independently testable without a database, and keeps the actual DB
 * queries in exactly one place (the monitor) rather than scattered through
 * decision logic.
 */

import {
  TransferMatchStatus,
  type TransferMatchStatusValue,
  isPayableStatus,
  type InvoiceStatusValue,
} from '@gateway/shared';

export interface MatchInput {
  /** False when the destination is one of ours but no allowlisted asset matches the contract/native coin. */
  assetRecognized: boolean;
  /** False when the transfer amount is below the asset's dust threshold. */
  meetsMinimum: boolean;
  /** The transaction's on-chain execution result. */
  txStatus: 'PENDING' | 'SUCCESS' | 'REVERTED';
  /** Null when the destination address belongs to us but no invoice claims it. */
  invoiceStatus: InvoiceStatusValue | null;
  /** True once the invoice's expiry has passed. */
  invoiceExpired: boolean;
  /** True when this exact (network, tx_hash, transfer_index) already has creditedAt set. */
  alreadyCredited: boolean;
  /** True when a compliance rule holds this transfer for review. */
  complianceHold: boolean;
}

export interface MatchDecision {
  status: TransferMatchStatusValue;
  reason: string;
}

/**
 * Decide what to do with a detected transfer. Order matters: idempotency
 * (already credited) is checked before anything else, because re-deciding a
 * transfer that was already credited must never produce a different verdict
 * on replay - the monitor re-scanning a block must be a no-op, not a
 * re-classification.
 */
export function evaluateTransferMatch(input: MatchInput): MatchDecision {
  if (input.alreadyCredited) {
    return { status: TransferMatchStatus.CREDITED, reason: 'already credited; idempotent replay' };
  }

  if (input.txStatus === 'REVERTED') {
    return { status: TransferMatchStatus.UNMATCHED, reason: 'transaction reverted on-chain' };
  }

  if (!input.assetRecognized) {
    return { status: TransferMatchStatus.UNSUPPORTED_ASSET, reason: 'destination is ours but the asset is not allowlisted' };
  }

  if (!input.meetsMinimum) {
    return { status: TransferMatchStatus.BELOW_MINIMUM, reason: 'amount is below the asset dust threshold' };
  }

  if (input.complianceHold) {
    return { status: TransferMatchStatus.COMPLIANCE_HOLD, reason: 'held pending compliance review' };
  }

  if (input.invoiceStatus === null) {
    return { status: TransferMatchStatus.UNMATCHED, reason: 'destination is ours but no invoice claims it' };
  }

  // SPEC section 28: a payment for an invoice that has already left the
  // payable window is never silently credited or silently dropped.
  if (input.invoiceExpired || !isPayableStatus(input.invoiceStatus)) {
    return { status: TransferMatchStatus.LATE_PAYMENT_REVIEW, reason: `invoice is ${input.invoiceStatus}, not payable` };
  }

  return { status: TransferMatchStatus.PENDING_CONFIRMATION, reason: 'matched an open invoice, awaiting confirmations' };
}
