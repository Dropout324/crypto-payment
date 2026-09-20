import { InvoiceStatus, type InvoiceStatusValue, Money } from '@gateway/shared';

/**
 * Deciding whether a received amount settles an invoice (SPEC sections 12, 13).
 *
 * All comparisons are integer comparisons on smallest units. The merchant's
 * tolerances are basis points of the INVOICED amount, applied as an integer
 * ratio - never a percentage of a float.
 *
 * The default tolerance is zero: exact-or-more. A merchant who wants to absorb
 * dust differences opts in explicitly.
 */

export const PaymentOutcome = {
  /** Nothing has arrived yet. */
  NONE: 'NONE',
  /** Within tolerance of the invoiced amount. */
  EXACT: 'EXACT',
  /** Short by more than the underpayment tolerance. */
  UNDERPAID: 'UNDERPAID',
  /** Over by more than the overpayment tolerance. */
  OVERPAID: 'OVERPAID',
} as const;

export type PaymentOutcomeValue = (typeof PaymentOutcome)[keyof typeof PaymentOutcome];

export interface EvaluatePaymentInput {
  /** What the invoice asks for, in payment-asset smallest units. */
  required: Money;
  /** What has actually been received and counted so far. */
  received: Money;
  /** Shortfall absorbed without flagging, in basis points of `required`. */
  underpaymentToleranceBps?: number;
  /** Excess absorbed without flagging, in basis points of `required`. */
  overpaymentToleranceBps?: number;
}

export interface PaymentEvaluation {
  outcome: PaymentOutcomeValue;
  /** required - received, floored at zero. */
  shortfall: Money;
  /** received - required, floored at zero. */
  excess: Money;
  /** Lowest amount that counts as settled, after tolerance. */
  minimumAccepted: Money;
  /** Highest amount that counts as settled, after tolerance. */
  maximumAccepted: Money;
  /**
   * True when the merchant can safely release goods: the amount is within the
   * accepted band. False for both under- and overpayment, which need a policy
   * decision first.
   */
  satisfiesInvoice: boolean;
}

function assertComparable(required: Money, received: Money): void {
  if (required.asset !== received.asset || required.decimals !== received.decimals) {
    throw new Error(
      `cannot evaluate ${received.asset}(${received.decimals}) against an invoice denominated in ${required.asset}(${required.decimals})`,
    );
  }
}

function validateBps(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 0 || value > 10_000) {
    throw new Error(`${label} must be an integer between 0 and 10000, received ${value}`);
  }
  return value;
}

export function evaluatePayment(input: EvaluatePaymentInput): PaymentEvaluation {
  const { required, received } = input;
  assertComparable(required, received);

  if (!required.isPositive) {
    throw new Error('invoice amount must be positive');
  }

  const underBps = validateBps(input.underpaymentToleranceBps ?? 0, 'underpaymentToleranceBps');
  const overBps = validateBps(input.overpaymentToleranceBps ?? 0, 'overpaymentToleranceBps');

  // Round the tolerance DOWN so a stated tolerance is never silently widened by
  // rounding; the merchant gets exactly what they configured, or slightly less.
  const underAllowance = required.percentageBps(underBps, 'floor');
  const overAllowance = required.percentageBps(overBps, 'floor');

  const minimumAccepted = required.subtract(underAllowance);
  const maximumAccepted = required.add(overAllowance);

  const zero = Money.zero(required.asset, required.decimals);
  const shortfall = received.lessThan(required) ? required.subtract(received) : zero;
  const excess = received.greaterThan(required) ? received.subtract(required) : zero;

  let outcome: PaymentOutcomeValue;
  if (received.isZero) {
    outcome = PaymentOutcome.NONE;
  } else if (received.lessThan(minimumAccepted)) {
    outcome = PaymentOutcome.UNDERPAID;
  } else if (received.greaterThan(maximumAccepted)) {
    outcome = PaymentOutcome.OVERPAID;
  } else {
    outcome = PaymentOutcome.EXACT;
  }

  return {
    outcome,
    shortfall,
    excess,
    minimumAccepted,
    maximumAccepted,
    satisfiesInvoice: outcome === PaymentOutcome.EXACT,
  };
}

/**
 * Map an evaluation to the status a CONFIRMING invoice should move to.
 * Returns null when the invoice should stay where it is.
 */
export function statusForOutcome(outcome: PaymentOutcomeValue): InvoiceStatusValue | null {
  switch (outcome) {
    case PaymentOutcome.EXACT:
      return InvoiceStatus.PAID;
    case PaymentOutcome.UNDERPAID:
      return InvoiceStatus.UNDERPAID;
    case PaymentOutcome.OVERPAID:
      return InvoiceStatus.OVERPAID;
    case PaymentOutcome.NONE:
      return null;
    default: {
      const exhaustive: never = outcome;
      throw new Error(`unhandled outcome: ${String(exhaustive)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Expiry (SPEC section 28)
// ---------------------------------------------------------------------------

export interface ExpiryDecision {
  expired: boolean;
  /** Milliseconds remaining; negative once past expiry. */
  remainingMs: number;
  /**
   * True when funds arriving now must go to LATE_PAYMENT_REVIEW rather than
   * being credited.
   */
  lateArrival: boolean;
}

export function evaluateExpiry(expiresAt: Date, now: Date = new Date()): ExpiryDecision {
  const remainingMs = expiresAt.getTime() - now.getTime();
  const expired = remainingMs <= 0;
  return { expired, remainingMs, lateArrival: expired };
}

/**
 * Whether a transfer observed at `observedAt` may still be credited to an
 * invoice that expired at `expiresAt`.
 *
 * A grace period exists because block timestamps and our clock are not the
 * same clock: a payment broadcast comfortably before expiry can be mined after
 * it. Crediting it is correct; crediting one broadcast an hour later is not.
 */
export function isWithinGrace(
  expiresAt: Date,
  observedAt: Date,
  graceSeconds: number,
): boolean {
  if (graceSeconds < 0) throw new Error('graceSeconds must not be negative');
  return observedAt.getTime() <= expiresAt.getTime() + graceSeconds * 1000;
}
