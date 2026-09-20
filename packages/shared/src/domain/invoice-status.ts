/**
 * Invoice lifecycle states (SPEC section 6) plus the operational states that
 * keep money accounted for when the happy path does not apply.
 *
 * The authoritative transition table lives in @gateway/payments; this module
 * only declares the vocabulary and the terminal/settled classifications that
 * the database, API and dashboard all share.
 */
export const InvoiceStatus = {
  /** Row exists, no payment destination assigned yet. */
  CREATED: 'CREATED',
  /** Destination assigned, waiting for the customer to send funds. */
  PENDING: 'PENDING',
  /** A matching transaction is visible on-chain but unconfirmed. */
  DETECTED: 'DETECTED',
  /** Confirmations accruing, threshold not yet reached. */
  CONFIRMING: 'CONFIRMING',
  /** Fully confirmed and the received amount satisfies the invoice. */
  PAID: 'PAID',
  /** Confirmed, but received less than required. Merchant policy decides. */
  UNDERPAID: 'UNDERPAID',
  /** Confirmed, but received more than required. Merchant policy decides. */
  OVERPAID: 'OVERPAID',
  /** Expiry elapsed with no sufficient payment. */
  EXPIRED: 'EXPIRED',
  /** Cancelled by the merchant before payment. */
  CANCELLED: 'CANCELLED',
  /** Processing failed in a way that needs engineering attention. */
  FAILED: 'FAILED',
  /** Funds returned to the customer, refund confirmed on-chain. */
  REFUNDED: 'REFUNDED',
  /** Held pending an AML/sanctions decision (SPEC section 24). */
  COMPLIANCE_REVIEW_REQUIRED: 'COMPLIANCE_REVIEW_REQUIRED',
  /** Funds arrived after expiry; never auto-credited (SPEC section 28). */
  LATE_PAYMENT_REVIEW: 'LATE_PAYMENT_REVIEW',
  /** Chain, database and ledger disagree; frozen until a human resolves it. */
  RECONCILIATION_REQUIRED: 'RECONCILIATION_REQUIRED',
} as const;

export type InvoiceStatusValue = (typeof InvoiceStatus)[keyof typeof InvoiceStatus];

/** States from which no further automatic transition happens. */
export const TERMINAL_STATUSES: ReadonlySet<InvoiceStatusValue> = new Set([
  InvoiceStatus.PAID,
  InvoiceStatus.EXPIRED,
  InvoiceStatus.CANCELLED,
  InvoiceStatus.FAILED,
  InvoiceStatus.REFUNDED,
]);

/** States that require a human decision before the invoice can move on. */
export const REVIEW_STATUSES: ReadonlySet<InvoiceStatusValue> = new Set([
  InvoiceStatus.UNDERPAID,
  InvoiceStatus.OVERPAID,
  InvoiceStatus.COMPLIANCE_REVIEW_REQUIRED,
  InvoiceStatus.LATE_PAYMENT_REVIEW,
  InvoiceStatus.RECONCILIATION_REQUIRED,
]);

/** States in which the invoice can still legitimately receive a payment. */
export const PAYABLE_STATUSES: ReadonlySet<InvoiceStatusValue> = new Set([
  InvoiceStatus.PENDING,
  InvoiceStatus.DETECTED,
  InvoiceStatus.CONFIRMING,
  InvoiceStatus.UNDERPAID,
]);

export function isTerminalStatus(status: InvoiceStatusValue): boolean {
  return TERMINAL_STATUSES.has(status);
}

export function isReviewStatus(status: InvoiceStatusValue): boolean {
  return REVIEW_STATUSES.has(status);
}

export function isPayableStatus(status: InvoiceStatusValue): boolean {
  return PAYABLE_STATUSES.has(status);
}

/** Webhook event names, one per externally meaningful transition (SPEC section 17). */
export const WebhookEventType = {
  PAYMENT_CREATED: 'payment.created',
  PAYMENT_DETECTED: 'payment.detected',
  PAYMENT_CONFIRMING: 'payment.confirming',
  PAYMENT_PAID: 'payment.paid',
  PAYMENT_UNDERPAID: 'payment.underpaid',
  PAYMENT_OVERPAID: 'payment.overpaid',
  PAYMENT_EXPIRED: 'payment.expired',
  PAYMENT_CANCELLED: 'payment.cancelled',
  PAYMENT_REFUNDED: 'payment.refunded',
} as const;

export type WebhookEventTypeValue = (typeof WebhookEventType)[keyof typeof WebhookEventType];
