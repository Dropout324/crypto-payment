import { Money } from '@gateway/shared';
import { describe, expect, it } from 'vitest';
import {
  PaymentOutcome,
  evaluateExpiry,
  evaluatePayment,
  isWithinGrace,
  statusForOutcome,
} from '../src/payment-evaluation.js';

const usdt = (value: string) => Money.fromDecimal(value, 'USDT', 6);

describe('evaluatePayment: zero tolerance (the default)', () => {
  it('is EXACT when the amount matches exactly', () => {
    const result = evaluatePayment({ required: usdt('100'), received: usdt('100') });
    expect(result.outcome).toBe(PaymentOutcome.EXACT);
    expect(result.satisfiesInvoice).toBe(true);
    expect(result.shortfall.isZero).toBe(true);
    expect(result.excess.isZero).toBe(true);
  });

  it('is UNDERPAID by a single smallest unit', () => {
    const required = usdt('100');
    const received = Money.fromUnits(required.units - 1n, 'USDT', 6);
    const result = evaluatePayment({ required, received });

    expect(result.outcome).toBe(PaymentOutcome.UNDERPAID);
    expect(result.satisfiesInvoice).toBe(false);
    expect(result.shortfall.units).toBe(1n);
  });

  it('is OVERPAID by a single smallest unit', () => {
    const required = usdt('100');
    const received = Money.fromUnits(required.units + 1n, 'USDT', 6);
    const result = evaluatePayment({ required, received });

    expect(result.outcome).toBe(PaymentOutcome.OVERPAID);
    expect(result.excess.units).toBe(1n);
  });

  it('is NONE when nothing has arrived', () => {
    const result = evaluatePayment({ required: usdt('100'), received: usdt('0') });
    expect(result.outcome).toBe(PaymentOutcome.NONE);
    expect(result.satisfiesInvoice).toBe(false);
  });
});

describe('evaluatePayment: tolerances', () => {
  it('absorbs a shortfall within the underpayment tolerance', () => {
    // 1% tolerance on 100 USDT = 1 USDT absorbed.
    const result = evaluatePayment({
      required: usdt('100'),
      received: usdt('99.50'),
      underpaymentToleranceBps: 100,
    });
    expect(result.outcome).toBe(PaymentOutcome.EXACT);
  });

  it('still flags a shortfall beyond the tolerance', () => {
    const result = evaluatePayment({
      required: usdt('100'),
      received: usdt('98.50'),
      underpaymentToleranceBps: 100,
    });
    expect(result.outcome).toBe(PaymentOutcome.UNDERPAID);
  });

  it('absorbs excess within the overpayment tolerance', () => {
    const result = evaluatePayment({
      required: usdt('100'),
      received: usdt('100.50'),
      overpaymentToleranceBps: 100,
    });
    expect(result.outcome).toBe(PaymentOutcome.EXACT);
  });

  it('rounds the tolerance down rather than widening it', () => {
    // 33.33 tolerance-bps of 1 unit would round to 0.0033 units; flooring
    // means the merchant gets no more slack than requested, never more.
    const required = usdt('0.000001');
    const result = evaluatePayment({
      required,
      received: Money.fromUnits(0n, 'USDT', 6),
      underpaymentToleranceBps: 5000,
    });
    // 50% of 1 unit floors to 0, so minimumAccepted stays at the full amount.
    expect(result.minimumAccepted.units).toBe(1n);
  });

  it('rejects an out-of-range tolerance', () => {
    expect(() =>
      evaluatePayment({ required: usdt('100'), received: usdt('100'), underpaymentToleranceBps: 10_001 }),
    ).toThrow(/between 0 and 10000/);
    expect(() =>
      evaluatePayment({ required: usdt('100'), received: usdt('100'), overpaymentToleranceBps: -1 }),
    ).toThrow(/between 0 and 10000/);
  });
});

describe('evaluatePayment: guards', () => {
  it('refuses to compare different assets', () => {
    const eth = Money.fromDecimal('1', 'ETH', 18);
    expect(() => evaluatePayment({ required: usdt('100'), received: eth })).toThrow(
      /cannot evaluate/,
    );
  });

  it('refuses a non-positive invoice amount', () => {
    expect(() =>
      evaluatePayment({ required: usdt('0'), received: usdt('0') }),
    ).toThrow(/must be positive/);
  });
});

describe('statusForOutcome', () => {
  it('maps every outcome to the documented status', () => {
    expect(statusForOutcome(PaymentOutcome.EXACT)).toBe('PAID');
    expect(statusForOutcome(PaymentOutcome.UNDERPAID)).toBe('UNDERPAID');
    expect(statusForOutcome(PaymentOutcome.OVERPAID)).toBe('OVERPAID');
    expect(statusForOutcome(PaymentOutcome.NONE)).toBeNull();
  });
});

describe('expiry', () => {
  it('is not expired before the deadline', () => {
    const decision = evaluateExpiry(new Date('2026-01-01T00:15:00Z'), new Date('2026-01-01T00:00:00Z'));
    expect(decision.expired).toBe(false);
    expect(decision.remainingMs).toBe(900_000);
  });

  it('is expired exactly at the deadline', () => {
    const at = new Date('2026-01-01T00:15:00Z');
    const decision = evaluateExpiry(at, at);
    expect(decision.expired).toBe(true);
    expect(decision.lateArrival).toBe(true);
  });

  it('is expired after the deadline', () => {
    const decision = evaluateExpiry(new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T00:00:01Z'));
    expect(decision.expired).toBe(true);
  });
});

describe('late-payment grace window', () => {
  const expiresAt = new Date('2026-01-01T00:15:00Z');

  it('accepts a transaction observed just before expiry', () => {
    expect(isWithinGrace(expiresAt, new Date('2026-01-01T00:14:59Z'), 120)).toBe(true);
  });

  it('accepts a transaction observed within the grace window after expiry', () => {
    expect(isWithinGrace(expiresAt, new Date('2026-01-01T00:16:30Z'), 120)).toBe(true);
  });

  it('rejects a transaction observed after the grace window', () => {
    expect(isWithinGrace(expiresAt, new Date('2026-01-01T00:20:00Z'), 120)).toBe(false);
  });

  it('rejects a negative grace period', () => {
    expect(() => isWithinGrace(expiresAt, new Date(), -1)).toThrow(/must not be negative/);
  });
});
