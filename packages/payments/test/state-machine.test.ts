import { InvoiceStatus, type InvoiceStatusValue, WebhookEventType } from '@gateway/shared';
import { describe, expect, it } from 'vitest';
import {
  InvalidTransitionError,
  TRANSITIONS,
  TransitionActor,
  allowedTransitions,
  assertTransition,
  canTransition,
  isActorAllowed,
  webhookEventForStatus,
} from '../src/state-machine.js';

const ALL_STATUSES = Object.values(InvoiceStatus) as InvoiceStatusValue[];

describe('the happy path', () => {
  it('walks CREATED -> PENDING -> DETECTED -> CONFIRMING -> PAID', () => {
    expect(() =>
      assertTransition(InvoiceStatus.CREATED, InvoiceStatus.PENDING, TransitionActor.SYSTEM),
    ).not.toThrow();
    expect(() =>
      assertTransition(InvoiceStatus.PENDING, InvoiceStatus.DETECTED, TransitionActor.MONITOR),
    ).not.toThrow();
    expect(() =>
      assertTransition(InvoiceStatus.DETECTED, InvoiceStatus.CONFIRMING, TransitionActor.MONITOR),
    ).not.toThrow();
    expect(() =>
      assertTransition(InvoiceStatus.CONFIRMING, InvoiceStatus.PAID, TransitionActor.MONITOR),
    ).not.toThrow();
  });
});

describe('forbidden shortcuts', () => {
  it('never allows PENDING to jump straight to PAID', () => {
    // Skipping confirmation is the single most expensive bug this table prevents.
    expect(canTransition(InvoiceStatus.PENDING, InvoiceStatus.PAID)).toBe(false);
    expect(() =>
      assertTransition(InvoiceStatus.PENDING, InvoiceStatus.PAID, TransitionActor.MONITOR),
    ).toThrow(InvalidTransitionError);
  });

  it('never allows CREATED to reach PAID', () => {
    expect(canTransition(InvoiceStatus.CREATED, InvoiceStatus.PAID)).toBe(false);
  });

  it('never allows DETECTED to reach PAID without confirming', () => {
    expect(canTransition(InvoiceStatus.DETECTED, InvoiceStatus.PAID)).toBe(false);
  });

  it('never reopens an expired invoice as payable', () => {
    expect(canTransition(InvoiceStatus.EXPIRED, InvoiceStatus.PENDING)).toBe(false);
    expect(canTransition(InvoiceStatus.EXPIRED, InvoiceStatus.PAID)).toBe(false);
    expect(canTransition(InvoiceStatus.EXPIRED, InvoiceStatus.CONFIRMING)).toBe(false);
  });

  it('never reopens a cancelled invoice as payable', () => {
    expect(canTransition(InvoiceStatus.CANCELLED, InvoiceStatus.PENDING)).toBe(false);
    expect(canTransition(InvoiceStatus.CANCELLED, InvoiceStatus.PAID)).toBe(false);
  });

  it('never lets a PAID invoice quietly become PENDING again', () => {
    // A reorg after "paid" must surface, not rewind.
    expect(canTransition(InvoiceStatus.PAID, InvoiceStatus.PENDING)).toBe(false);
    expect(canTransition(InvoiceStatus.PAID, InvoiceStatus.CONFIRMING)).toBe(false);
    expect(canTransition(InvoiceStatus.PAID, InvoiceStatus.EXPIRED)).toBe(false);
    expect(canTransition(InvoiceStatus.PAID, InvoiceStatus.RECONCILIATION_REQUIRED)).toBe(true);
  });

  it('rejects a self-transition', () => {
    for (const status of ALL_STATUSES) {
      expect(() => assertTransition(status, status, TransitionActor.SYSTEM)).toThrow(
        /already in this state/,
      );
    }
  });
});

describe('reorg paths', () => {
  it('lets a detected payment fall back to pending when the transaction drops', () => {
    expect(
      isActorAllowed(InvoiceStatus.DETECTED, InvoiceStatus.PENDING, TransitionActor.MONITOR),
    ).toBe(true);
  });

  it('lets confirmations go backwards', () => {
    expect(
      isActorAllowed(InvoiceStatus.CONFIRMING, InvoiceStatus.DETECTED, TransitionActor.MONITOR),
    ).toBe(true);
    expect(
      isActorAllowed(InvoiceStatus.CONFIRMING, InvoiceStatus.PENDING, TransitionActor.MONITOR),
    ).toBe(true);
  });

  it('sends an orphaned PAID invoice to reconciliation, not back to the flow', () => {
    expect(allowedTransitions(InvoiceStatus.PAID).map((r) => r.to)).toEqual(
      expect.arrayContaining([
        InvoiceStatus.RECONCILIATION_REQUIRED,
        InvoiceStatus.REFUNDED,
        InvoiceStatus.COMPLIANCE_REVIEW_REQUIRED,
      ]),
    );
  });
});

describe('late payments (SPEC section 28)', () => {
  it('routes funds arriving after expiry to review', () => {
    expect(
      isActorAllowed(
        InvoiceStatus.EXPIRED,
        InvoiceStatus.LATE_PAYMENT_REVIEW,
        TransitionActor.MONITOR,
      ),
    ).toBe(true);
  });

  it('routes funds arriving after cancellation to review', () => {
    expect(
      isActorAllowed(
        InvoiceStatus.CANCELLED,
        InvoiceStatus.LATE_PAYMENT_REVIEW,
        TransitionActor.MONITOR,
      ),
    ).toBe(true);
  });

  it('leaves every terminal state with a path for money that still arrives', () => {
    // No terminal state may be a dead end for funds.
    for (const status of [InvoiceStatus.EXPIRED, InvoiceStatus.CANCELLED]) {
      expect(allowedTransitions(status).length).toBeGreaterThan(0);
    }
  });

  it('requires a human to accept a late payment', () => {
    expect(
      isActorAllowed(
        InvoiceStatus.LATE_PAYMENT_REVIEW,
        InvoiceStatus.PAID,
        TransitionActor.MONITOR,
      ),
    ).toBe(false);
    expect(
      isActorAllowed(InvoiceStatus.LATE_PAYMENT_REVIEW, InvoiceStatus.PAID, TransitionActor.ADMIN),
    ).toBe(true);
  });
});

describe('actor authorisation', () => {
  it('does not let a merchant mark their own invoice paid', () => {
    expect(
      isActorAllowed(InvoiceStatus.CONFIRMING, InvoiceStatus.PAID, TransitionActor.MERCHANT),
    ).toBe(false);
    expect(() =>
      assertTransition(InvoiceStatus.CONFIRMING, InvoiceStatus.PAID, TransitionActor.MERCHANT),
    ).toThrow(/may not perform this transition/);
  });

  it('does not let the monitor cancel an invoice', () => {
    expect(
      isActorAllowed(InvoiceStatus.PENDING, InvoiceStatus.CANCELLED, TransitionActor.MONITOR),
    ).toBe(false);
  });

  it('lets a merchant cancel an unpaid invoice', () => {
    expect(
      isActorAllowed(InvoiceStatus.PENDING, InvoiceStatus.CANCELLED, TransitionActor.MERCHANT),
    ).toBe(true);
  });

  it('does not let a merchant cancel an invoice that is already confirming', () => {
    expect(
      isActorAllowed(InvoiceStatus.CONFIRMING, InvoiceStatus.CANCELLED, TransitionActor.MERCHANT),
    ).toBe(false);
  });

  it('reserves reconciliation outcomes for admins', () => {
    for (const target of [InvoiceStatus.PAID, InvoiceStatus.UNDERPAID, InvoiceStatus.FAILED]) {
      expect(
        isActorAllowed(InvoiceStatus.RECONCILIATION_REQUIRED, target, TransitionActor.MONITOR),
      ).toBe(false);
      expect(
        isActorAllowed(InvoiceStatus.RECONCILIATION_REQUIRED, target, TransitionActor.ADMIN),
      ).toBe(true);
    }
  });

  it('only lets compliance clear a compliance hold', () => {
    expect(
      isActorAllowed(
        InvoiceStatus.COMPLIANCE_REVIEW_REQUIRED,
        InvoiceStatus.PAID,
        TransitionActor.COMPLIANCE,
      ),
    ).toBe(true);
    expect(
      isActorAllowed(
        InvoiceStatus.COMPLIANCE_REVIEW_REQUIRED,
        InvoiceStatus.PAID,
        TransitionActor.MERCHANT,
      ),
    ).toBe(false);
  });
});

describe('underpayment recovery', () => {
  it('lets a topped-up invoice confirm again', () => {
    expect(
      isActorAllowed(InvoiceStatus.UNDERPAID, InvoiceStatus.CONFIRMING, TransitionActor.MONITOR),
    ).toBe(true);
  });

  it('lets an admin accept a partial payment as settled', () => {
    expect(
      isActorAllowed(InvoiceStatus.UNDERPAID, InvoiceStatus.PAID, TransitionActor.ADMIN),
    ).toBe(true);
  });

  it('lets an underpaid invoice expire', () => {
    expect(
      isActorAllowed(InvoiceStatus.UNDERPAID, InvoiceStatus.EXPIRED, TransitionActor.SYSTEM),
    ).toBe(true);
  });
});

describe('table integrity', () => {
  it('declares an entry for every status', () => {
    for (const status of ALL_STATUSES) {
      expect(TRANSITIONS[status]).toBeDefined();
    }
  });

  it('never targets an unknown status', () => {
    for (const rules of Object.values(TRANSITIONS)) {
      for (const rule of rules) {
        expect(ALL_STATUSES).toContain(rule.to);
      }
    }
  });

  it('never lists the same target twice from one state', () => {
    for (const [from, rules] of Object.entries(TRANSITIONS)) {
      const targets = rules.map((r) => r.to);
      expect(new Set(targets).size, `duplicate target from ${from}`).toBe(targets.length);
    }
  });

  it('gives every transition at least one permitted actor and a reason', () => {
    for (const rules of Object.values(TRANSITIONS)) {
      for (const rule of rules) {
        expect(rule.actors.length).toBeGreaterThan(0);
        expect(rule.reason.length).toBeGreaterThan(10);
      }
    }
  });

  it('never lets a state transition to itself', () => {
    for (const [from, rules] of Object.entries(TRANSITIONS)) {
      expect(rules.map((r) => r.to)).not.toContain(from);
    }
  });

  it('makes every status reachable from CREATED', () => {
    const reachable = new Set<InvoiceStatusValue>([InvoiceStatus.CREATED]);
    const queue: InvoiceStatusValue[] = [InvoiceStatus.CREATED];

    while (queue.length > 0) {
      const current = queue.shift() as InvoiceStatusValue;
      for (const rule of TRANSITIONS[current] ?? []) {
        if (!reachable.has(rule.to)) {
          reachable.add(rule.to);
          queue.push(rule.to);
        }
      }
    }

    // An unreachable status is dead code that will drift out of sync.
    for (const status of ALL_STATUSES) {
      expect(reachable.has(status), `${status} is unreachable`).toBe(true);
    }
  });
});

describe('webhook mapping', () => {
  it('emits the documented event for each merchant-visible status', () => {
    expect(webhookEventForStatus(InvoiceStatus.PENDING)).toBe(WebhookEventType.PAYMENT_CREATED);
    expect(webhookEventForStatus(InvoiceStatus.DETECTED)).toBe(WebhookEventType.PAYMENT_DETECTED);
    expect(webhookEventForStatus(InvoiceStatus.PAID)).toBe(WebhookEventType.PAYMENT_PAID);
    expect(webhookEventForStatus(InvoiceStatus.UNDERPAID)).toBe(WebhookEventType.PAYMENT_UNDERPAID);
    expect(webhookEventForStatus(InvoiceStatus.OVERPAID)).toBe(WebhookEventType.PAYMENT_OVERPAID);
    expect(webhookEventForStatus(InvoiceStatus.EXPIRED)).toBe(WebhookEventType.PAYMENT_EXPIRED);
    expect(webhookEventForStatus(InvoiceStatus.REFUNDED)).toBe(WebhookEventType.PAYMENT_REFUNDED);
  });

  it('does not leak internal states to merchants', () => {
    expect(webhookEventForStatus(InvoiceStatus.RECONCILIATION_REQUIRED)).toBeNull();
    expect(webhookEventForStatus(InvoiceStatus.LATE_PAYMENT_REVIEW)).toBeNull();
    expect(webhookEventForStatus(InvoiceStatus.COMPLIANCE_REVIEW_REQUIRED)).toBeNull();
    expect(webhookEventForStatus(InvoiceStatus.CREATED)).toBeNull();
  });
});
