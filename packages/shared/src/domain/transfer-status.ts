/**
 * Why a detected on-chain transfer was or was not credited (SPEC section 11).
 *
 * Lives here, not in `@gateway/database`, so the matching decision logic in
 * `@gateway/payments` stays free of any ORM dependency - this vocabulary is
 * domain logic, not storage. `packages/database`'s Prisma schema declares an
 * identically-valued enum for the `token_transfers.match_status` column; the
 * two are kept in sync by convention (this file is the source of truth).
 */
export const TransferMatchStatus = {
  /** Matched an open invoice and was credited. */
  CREDITED: 'CREDITED',
  /** Matched an invoice, awaiting confirmations. */
  PENDING_CONFIRMATION: 'PENDING_CONFIRMATION',
  /** Arrived after expiry/cancellation - queued for review, never auto-credited. */
  LATE_PAYMENT_REVIEW: 'LATE_PAYMENT_REVIEW',
  /** The destination is ours but the asset is not allowlisted. */
  UNSUPPORTED_ASSET: 'UNSUPPORTED_ASSET',
  /** Below the asset's dust threshold. */
  BELOW_MINIMUM: 'BELOW_MINIMUM',
  /** Destination address belongs to us but no invoice claims it. */
  UNMATCHED: 'UNMATCHED',
  /** Held by a compliance rule. */
  COMPLIANCE_HOLD: 'COMPLIANCE_HOLD',
  /** Ignored after a reorg removed the underlying transaction. */
  ORPHANED: 'ORPHANED',
} as const;

export type TransferMatchStatusValue = (typeof TransferMatchStatus)[keyof typeof TransferMatchStatus];
