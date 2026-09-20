import {
  AppError,
  ErrorCode,
  InvoiceStatus,
  type InvoiceStatusValue,
  WebhookEventType,
  type WebhookEventTypeValue,
} from '@gateway/shared';

/**
 * INVOICE STATE MACHINE (SPEC section 6).
 *
 * Every status change in the system goes through `assertTransition`. There is
 * no other way to move an invoice, so an invalid transition is impossible to
 * express rather than merely discouraged.
 *
 * Two rules shape the table:
 *
 *  1. A reorg can undo anything. DETECTED can fall back to PENDING, CONFIRMING
 *     back to DETECTED, and a PAID invoice whose transaction is orphaned goes
 *     to RECONCILIATION_REQUIRED - never silently back to PENDING, because the
 *     merchant has already been told it was paid.
 *  2. Money never disappears. Terminal states still accept
 *     LATE_PAYMENT_REVIEW, so funds arriving after expiry or cancellation are
 *     recorded rather than dropped.
 */

/** Who is permitted to drive a transition. */
export const TransitionActor = {
  /** Internal services: expiry sweeper, ledger, settlement. */
  SYSTEM: 'system',
  /** The blockchain monitor and confirmation engine. */
  MONITOR: 'monitor',
  /** The merchant, via the API or dashboard. */
  MERCHANT: 'merchant',
  /** Platform staff resolving a review queue. */
  ADMIN: 'admin',
  /** Compliance officer acting on a screening result. */
  COMPLIANCE: 'compliance',
} as const;

export type TransitionActorValue = (typeof TransitionActor)[keyof typeof TransitionActor];

export interface TransitionRule {
  to: InvoiceStatusValue;
  /** Actors allowed to perform this transition. */
  actors: readonly TransitionActorValue[];
  /** Why this edge exists, for documentation and audit messages. */
  reason: string;
}

const ANY_INTERNAL = [TransitionActor.SYSTEM, TransitionActor.MONITOR] as const;
const HUMAN_REVIEW = [TransitionActor.ADMIN, TransitionActor.COMPLIANCE] as const;

/**
 * The complete transition table. An edge that is not listed here cannot happen.
 */
export const TRANSITIONS: Readonly<Record<InvoiceStatusValue, readonly TransitionRule[]>> =
  Object.freeze({
    [InvoiceStatus.CREATED]: [
      {
        to: InvoiceStatus.PENDING,
        actors: [TransitionActor.SYSTEM],
        reason: 'payment destination assigned',
      },
      {
        to: InvoiceStatus.CANCELLED,
        actors: [TransitionActor.MERCHANT, TransitionActor.ADMIN],
        reason: 'cancelled before a destination was issued',
      },
      {
        to: InvoiceStatus.FAILED,
        actors: [TransitionActor.SYSTEM],
        reason: 'no address could be assigned',
      },
      {
        to: InvoiceStatus.COMPLIANCE_REVIEW_REQUIRED,
        actors: [...HUMAN_REVIEW, TransitionActor.SYSTEM],
        reason: 'screening flagged the merchant or invoice',
      },
    ],

    [InvoiceStatus.PENDING]: [
      {
        to: InvoiceStatus.DETECTED,
        actors: [TransitionActor.MONITOR],
        reason: 'a matching transfer appeared on-chain',
      },
      {
        to: InvoiceStatus.EXPIRED,
        actors: [TransitionActor.SYSTEM],
        reason: 'expiry elapsed with no payment',
      },
      {
        to: InvoiceStatus.CANCELLED,
        actors: [TransitionActor.MERCHANT, TransitionActor.ADMIN],
        reason: 'cancelled by the merchant',
      },
      {
        to: InvoiceStatus.FAILED,
        actors: [TransitionActor.SYSTEM],
        reason: 'unrecoverable processing error',
      },
      {
        to: InvoiceStatus.COMPLIANCE_REVIEW_REQUIRED,
        actors: [...HUMAN_REVIEW, TransitionActor.SYSTEM],
        reason: 'screening flagged the invoice',
      },
    ],

    [InvoiceStatus.DETECTED]: [
      {
        to: InvoiceStatus.CONFIRMING,
        actors: [TransitionActor.MONITOR],
        reason: 'transaction mined, confirmations accruing',
      },
      {
        to: InvoiceStatus.PENDING,
        actors: [TransitionActor.MONITOR],
        reason: 'transaction dropped, replaced or orphaned before confirming',
      },
      {
        to: InvoiceStatus.FAILED,
        actors: [TransitionActor.SYSTEM],
        reason: 'unrecoverable processing error',
      },
      {
        to: InvoiceStatus.COMPLIANCE_REVIEW_REQUIRED,
        actors: [...HUMAN_REVIEW, TransitionActor.MONITOR],
        reason: 'the paying address was flagged',
      },
    ],

    [InvoiceStatus.CONFIRMING]: [
      {
        to: InvoiceStatus.PAID,
        actors: [TransitionActor.MONITOR],
        reason: 'confirmation threshold reached and the amount satisfies the invoice',
      },
      {
        to: InvoiceStatus.UNDERPAID,
        actors: [TransitionActor.MONITOR],
        reason: 'confirmed, but less than the invoiced amount was received',
      },
      {
        to: InvoiceStatus.OVERPAID,
        actors: [TransitionActor.MONITOR],
        reason: 'confirmed, but more than the invoiced amount was received',
      },
      {
        to: InvoiceStatus.DETECTED,
        actors: [TransitionActor.MONITOR],
        reason: 'reorg reduced the confirmation count',
      },
      {
        to: InvoiceStatus.PENDING,
        actors: [TransitionActor.MONITOR],
        reason: 'reorg removed the transaction entirely',
      },
      {
        to: InvoiceStatus.FAILED,
        actors: [TransitionActor.SYSTEM],
        reason: 'unrecoverable processing error',
      },
      {
        to: InvoiceStatus.COMPLIANCE_REVIEW_REQUIRED,
        actors: [...HUMAN_REVIEW, TransitionActor.MONITOR],
        reason: 'screening flagged the payment',
      },
      {
        to: InvoiceStatus.RECONCILIATION_REQUIRED,
        actors: ANY_INTERNAL,
        reason: 'chain, database and ledger disagree',
      },
    ],

    [InvoiceStatus.PAID]: [
      {
        to: InvoiceStatus.REFUNDED,
        actors: [TransitionActor.SYSTEM],
        reason: 'an approved refund confirmed on-chain',
      },
      {
        // A reorg after we told the merchant "paid" is never resolved silently.
        to: InvoiceStatus.RECONCILIATION_REQUIRED,
        actors: ANY_INTERNAL,
        reason: 'the settling transaction was orphaned after the invoice was marked paid',
      },
      {
        to: InvoiceStatus.COMPLIANCE_REVIEW_REQUIRED,
        actors: HUMAN_REVIEW,
        reason: 'post-payment screening flagged the transaction',
      },
    ],

    [InvoiceStatus.UNDERPAID]: [
      {
        to: InvoiceStatus.CONFIRMING,
        actors: [TransitionActor.MONITOR],
        reason: 'an additional transfer arrived and is confirming',
      },
      {
        to: InvoiceStatus.PAID,
        actors: [TransitionActor.MONITOR, TransitionActor.ADMIN],
        reason: 'topped up to the full amount, or accepted under the merchant policy',
      },
      {
        to: InvoiceStatus.EXPIRED,
        actors: [TransitionActor.SYSTEM],
        reason: 'expiry elapsed while still short',
      },
      {
        to: InvoiceStatus.CANCELLED,
        actors: [TransitionActor.MERCHANT, TransitionActor.ADMIN],
        reason: 'merchant rejected the partial payment',
      },
      {
        to: InvoiceStatus.REFUNDED,
        actors: [TransitionActor.SYSTEM],
        reason: 'the partial payment was returned to the customer',
      },
      {
        to: InvoiceStatus.FAILED,
        actors: [TransitionActor.SYSTEM],
        reason: 'unrecoverable processing error',
      },
      {
        to: InvoiceStatus.RECONCILIATION_REQUIRED,
        actors: ANY_INTERNAL,
        reason: 'chain, database and ledger disagree',
      },
    ],

    [InvoiceStatus.OVERPAID]: [
      {
        to: InvoiceStatus.PAID,
        // Symmetric with UNDERPAID -> PAID below: MONITOR performs this
        // transition itself when the merchant's overpayment_policy is
        // ACCEPT_FULL - an automated policy application, not a human
        // decision, exactly like the underpayment side.
        actors: [TransitionActor.MONITOR, TransitionActor.SYSTEM, TransitionActor.ADMIN],
        reason: 'excess accepted (automatically, under ACCEPT_FULL) or credited under the merchant policy',
      },
      {
        to: InvoiceStatus.REFUNDED,
        actors: [TransitionActor.SYSTEM],
        reason: 'the excess was returned to the customer',
      },
      {
        to: InvoiceStatus.RECONCILIATION_REQUIRED,
        actors: ANY_INTERNAL,
        reason: 'chain, database and ledger disagree',
      },
      {
        to: InvoiceStatus.FAILED,
        actors: [TransitionActor.SYSTEM],
        reason: 'unrecoverable processing error',
      },
    ],

    [InvoiceStatus.EXPIRED]: [
      {
        // SPEC section 28: a late payment must never simply vanish.
        to: InvoiceStatus.LATE_PAYMENT_REVIEW,
        actors: [TransitionActor.MONITOR],
        reason: 'funds arrived after expiry',
      },
    ],

    [InvoiceStatus.CANCELLED]: [
      {
        to: InvoiceStatus.LATE_PAYMENT_REVIEW,
        actors: [TransitionActor.MONITOR],
        reason: 'funds arrived after cancellation',
      },
    ],

    [InvoiceStatus.FAILED]: [
      {
        to: InvoiceStatus.RECONCILIATION_REQUIRED,
        actors: ANY_INTERNAL,
        reason: 'the failure left funds unaccounted for',
      },
      {
        to: InvoiceStatus.PENDING,
        actors: [TransitionActor.ADMIN],
        reason: 'the underlying fault was fixed and the invoice was reopened',
      },
    ],

    [InvoiceStatus.REFUNDED]: [
      {
        to: InvoiceStatus.RECONCILIATION_REQUIRED,
        actors: ANY_INTERNAL,
        reason: 'the refund transaction was orphaned or disputed',
      },
    ],

    [InvoiceStatus.COMPLIANCE_REVIEW_REQUIRED]: [
      {
        to: InvoiceStatus.PENDING,
        actors: [TransitionActor.COMPLIANCE],
        reason: 'cleared before any payment arrived',
      },
      {
        to: InvoiceStatus.CONFIRMING,
        actors: [TransitionActor.COMPLIANCE],
        reason: 'cleared while a payment was confirming',
      },
      {
        to: InvoiceStatus.PAID,
        actors: [TransitionActor.COMPLIANCE],
        reason: 'cleared and the payment already satisfied the invoice',
      },
      {
        to: InvoiceStatus.CANCELLED,
        actors: HUMAN_REVIEW,
        reason: 'blocked by compliance before payment',
      },
      {
        to: InvoiceStatus.REFUNDED,
        actors: [TransitionActor.SYSTEM],
        reason: 'blocked by compliance and the funds were returned',
      },
      {
        to: InvoiceStatus.FAILED,
        actors: HUMAN_REVIEW,
        reason: 'blocked by compliance with no return path',
      },
    ],

    [InvoiceStatus.LATE_PAYMENT_REVIEW]: [
      {
        to: InvoiceStatus.PAID,
        actors: [TransitionActor.ADMIN],
        reason: 'the late payment was accepted by the merchant',
      },
      {
        to: InvoiceStatus.REFUNDED,
        actors: [TransitionActor.SYSTEM],
        reason: 'the late payment was returned to the customer',
      },
      {
        to: InvoiceStatus.RECONCILIATION_REQUIRED,
        actors: ANY_INTERNAL,
        reason: 'the late payment could not be attributed',
      },
      {
        to: InvoiceStatus.COMPLIANCE_REVIEW_REQUIRED,
        actors: HUMAN_REVIEW,
        reason: 'the late payment was flagged by screening',
      },
    ],

    [InvoiceStatus.RECONCILIATION_REQUIRED]: [
      {
        to: InvoiceStatus.PAID,
        actors: [TransitionActor.ADMIN],
        reason: 'resolved in favour of the recorded payment',
      },
      {
        to: InvoiceStatus.UNDERPAID,
        actors: [TransitionActor.ADMIN],
        reason: 'resolved: less was actually received than recorded',
      },
      {
        to: InvoiceStatus.OVERPAID,
        actors: [TransitionActor.ADMIN],
        reason: 'resolved: more was actually received than recorded',
      },
      {
        to: InvoiceStatus.EXPIRED,
        actors: [TransitionActor.ADMIN],
        reason: 'resolved: no valid payment existed',
      },
      {
        to: InvoiceStatus.REFUNDED,
        actors: [TransitionActor.ADMIN],
        reason: 'resolved by returning the funds',
      },
      {
        to: InvoiceStatus.FAILED,
        actors: [TransitionActor.ADMIN],
        reason: 'resolved as an unrecoverable failure',
      },
    ],
  });

export class InvalidTransitionError extends AppError {
  readonly from: InvoiceStatusValue;
  readonly to: InvoiceStatusValue;

  constructor(from: InvoiceStatusValue, to: InvoiceStatusValue, detail: string) {
    super(ErrorCode.INVALID_STATE_TRANSITION, 409, `cannot move invoice ${from} -> ${to}: ${detail}`, {
      details: { from, to },
    });
    this.from = from;
    this.to = to;
  }
}

export function findRule(
  from: InvoiceStatusValue,
  to: InvoiceStatusValue,
): TransitionRule | undefined {
  return TRANSITIONS[from]?.find((rule) => rule.to === to);
}

export function canTransition(from: InvoiceStatusValue, to: InvoiceStatusValue): boolean {
  return findRule(from, to) !== undefined;
}

export function isActorAllowed(
  from: InvoiceStatusValue,
  to: InvoiceStatusValue,
  actor: TransitionActorValue,
): boolean {
  return findRule(from, to)?.actors.includes(actor) ?? false;
}

/**
 * The single gate every status change passes through. Throws rather than
 * returning a boolean, so a caller that forgets to check cannot proceed.
 */
export function assertTransition(
  from: InvoiceStatusValue,
  to: InvoiceStatusValue,
  actor: TransitionActorValue,
): TransitionRule {
  if (from === to) {
    throw new InvalidTransitionError(from, to, 'the invoice is already in this state');
  }

  const rule = findRule(from, to);
  if (!rule) {
    const allowed = (TRANSITIONS[from] ?? []).map((r) => r.to);
    throw new InvalidTransitionError(
      from,
      to,
      allowed.length > 0 ? `permitted targets are ${allowed.join(', ')}` : 'no transitions permitted',
    );
  }

  if (!rule.actors.includes(actor)) {
    throw new InvalidTransitionError(
      from,
      to,
      `${actor} may not perform this transition (allowed: ${rule.actors.join(', ')})`,
    );
  }

  return rule;
}

export function allowedTransitions(from: InvoiceStatusValue): readonly TransitionRule[] {
  return TRANSITIONS[from] ?? [];
}

/**
 * Webhook emitted when an invoice ENTERS a status. Statuses with no entry here
 * are internal and deliberately not exposed to merchants: telling a merchant
 * their paid invoice is "under reconciliation" is a support conversation, not
 * an automated event.
 */
const STATUS_EVENTS: Partial<Record<InvoiceStatusValue, WebhookEventTypeValue>> = {
  [InvoiceStatus.PENDING]: WebhookEventType.PAYMENT_CREATED,
  [InvoiceStatus.DETECTED]: WebhookEventType.PAYMENT_DETECTED,
  [InvoiceStatus.CONFIRMING]: WebhookEventType.PAYMENT_CONFIRMING,
  [InvoiceStatus.PAID]: WebhookEventType.PAYMENT_PAID,
  [InvoiceStatus.UNDERPAID]: WebhookEventType.PAYMENT_UNDERPAID,
  [InvoiceStatus.OVERPAID]: WebhookEventType.PAYMENT_OVERPAID,
  [InvoiceStatus.EXPIRED]: WebhookEventType.PAYMENT_EXPIRED,
  [InvoiceStatus.CANCELLED]: WebhookEventType.PAYMENT_CANCELLED,
  [InvoiceStatus.REFUNDED]: WebhookEventType.PAYMENT_REFUNDED,
};

export function webhookEventForStatus(status: InvoiceStatusValue): WebhookEventTypeValue | null {
  return STATUS_EVENTS[status] ?? null;
}
