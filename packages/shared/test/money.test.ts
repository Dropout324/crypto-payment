import { describe, expect, it } from 'vitest';
import { MoneyError } from '../src/money/decimal.js';
import { Money } from '../src/money/money.js';

const usdt = (value: string) => Money.fromDecimal(value, 'USDT', 6);
const eth = (value: string) => Money.fromDecimal(value, 'ETH', 18);

describe('Money construction', () => {
  it('carries asset and precision with the amount', () => {
    const amount = usdt('100.00');
    expect(amount.units).toBe(100_000_000n);
    expect(amount.asset).toBe('USDT');
    expect(amount.decimals).toBe(6);
    expect(amount.toDecimalString()).toBe('100.000000');
    expect(amount.toString()).toBe('100.000000 USDT');
  });

  it('is immutable', () => {
    const amount = usdt('10');
    expect(Object.isFrozen(amount)).toBe(true);
    const sum = amount.add(usdt('5'));
    expect(amount.units).toBe(10_000_000n);
    expect(sum.units).toBe(15_000_000n);
  });

  it('refuses a non-bigint units value', () => {
    expect(() => Money.fromUnits(100 as unknown as bigint, 'USDT', 6)).toThrow(MoneyError);
  });
});

describe('Money arithmetic', () => {
  it('adds and subtracts exactly', () => {
    expect(usdt('100.00').add(usdt('0.000001')).toDecimalString()).toBe('100.000001');
    expect(usdt('100.00').subtract(usdt('105.00')).toDecimalString()).toBe('-5.000000');
  });

  it('accumulates 0.1 + 0.2 without float drift', () => {
    // The canonical float bug: 0.1 + 0.2 === 0.30000000000000004
    const sum = eth('0.1').add(eth('0.2'));
    expect(sum.toDecimalString()).toBe('0.300000000000000000');
    expect(sum.equals(eth('0.3'))).toBe(true);
  });

  it('survives amounts far beyond Number.MAX_SAFE_INTEGER', () => {
    const huge = eth('1000000');
    expect(huge.units).toBe(10n ** 24n);
    expect(huge.add(eth('0.000000000000000001')).toDecimalString()).toBe(
      '1000000.000000000000000001',
    );
  });

  it('refuses to mix assets', () => {
    expect(() => usdt('1').add(eth('1'))).toThrow(/cannot combine USDT/);
  });

  it('refuses to mix precisions of the same symbol', () => {
    // USDT is 6 dp on Ethereum but 18 dp on BSC - never add them blindly.
    const usdtBsc = Money.fromDecimal('1', 'USDT', 18);
    expect(() => usdt('1').add(usdtBsc)).toThrow(MoneyError);
  });
});

describe('Money proportional maths', () => {
  it('multiplies by an integer factor', () => {
    expect(usdt('1.5').multiplyInteger(3n).toDecimalString()).toBe('4.500000');
  });

  it('applies basis-point fees with explicit rounding', () => {
    // 1% of 100 USDT
    expect(usdt('100').percentageBps(100).toDecimalString()).toBe('1.000000');
    // 0.25% of 33.33 USDT = 0.0833250 -> half-up at 6 dp
    expect(usdt('33.33').percentageBps(25).toDecimalString()).toBe('0.083325');
  });

  it('rounds fees in the requested direction', () => {
    const base = usdt('0.000001');
    expect(base.multiplyRatio(1n, 3n, 'floor').units).toBe(0n);
    expect(base.multiplyRatio(1n, 3n, 'ceil').units).toBe(1n);
    expect(base.multiplyRatio(1n, 2n, 'half-up').units).toBe(1n);
  });

  it('refuses a zero denominator', () => {
    expect(() => usdt('1').multiplyRatio(1n, 0n)).toThrow(MoneyError);
  });
});

describe('Money comparison', () => {
  it('orders amounts of the same asset', () => {
    expect(usdt('100').greaterThan(usdt('99.999999'))).toBe(true);
    expect(usdt('100').lessThan(usdt('100.000001'))).toBe(true);
    expect(usdt('100').greaterThanOrEqual(usdt('100'))).toBe(true);
    expect(usdt('100').compare(usdt('100'))).toBe(0);
  });

  it('drives underpayment and overpayment decisions', () => {
    const required = usdt('100');
    const underpaid = usdt('95');
    const overpaid = usdt('105');

    expect(underpaid.lessThan(required)).toBe(true);
    expect(overpaid.greaterThan(required)).toBe(true);
    expect(required.subtract(underpaid).toDecimalString()).toBe('5.000000');
    expect(overpaid.subtract(required).toDecimalString()).toBe('5.000000');
  });

  it('treats a one-unit shortfall as underpayment, not as paid', () => {
    const required = usdt('100');
    const received = Money.fromUnits(required.units - 1n, 'USDT', 6);
    expect(received.greaterThanOrEqual(required)).toBe(false);
  });

  it('refuses cross-asset comparison', () => {
    expect(() => usdt('1').compare(eth('1'))).toThrow(MoneyError);
  });
});

describe('Money serialisation', () => {
  it('serialises units as a string because JSON has no bigint', () => {
    expect(usdt('100.5').toJSON()).toEqual({
      units: '100500000',
      asset: 'USDT',
      decimals: 6,
      amount: '100.500000',
    });
  });

  it('survives a JSON round trip', () => {
    const original = eth('12.345678901234567890');
    const parsed = JSON.parse(JSON.stringify(original)) as { units: string };
    const restored = Money.fromUnits(BigInt(parsed.units), 'ETH', 18);
    expect(restored.equals(original)).toBe(true);
  });
});
