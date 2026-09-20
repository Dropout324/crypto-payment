import { describe, expect, it } from 'vitest';
import {
  MoneyError,
  divCeil,
  divFloor,
  divHalfUp,
  formatUnits,
  formatUnitsTrimmed,
  parseUnits,
  rescaleUnits,
} from '../src/money/decimal.js';

describe('parseUnits', () => {
  it('converts decimal strings to smallest units', () => {
    expect(parseUnits('100.00', 6)).toBe(100_000_000n);
    expect(parseUnits('1', 6)).toBe(1_000_000n);
    expect(parseUnits('0.000001', 6)).toBe(1n);
    expect(parseUnits('0', 8)).toBe(0n);
  });

  it('handles the 18-decimal wei scale without precision loss', () => {
    // 0.1 ETH is not representable as a float; it must be exact here.
    expect(parseUnits('0.1', 18)).toBe(100_000_000_000_000_000n);
    expect(parseUnits('1234567.123456789012345678', 18)).toBe(
      1_234_567_123_456_789_012_345_678n,
    );
  });

  it('supports zero-decimal currencies', () => {
    expect(parseUnits('1500', 0)).toBe(1500n);
  });

  it('handles negative amounts (refunds, reversals)', () => {
    expect(parseUnits('-25.50', 2)).toBe(-2550n);
  });

  it('rejects more decimal places than the asset supports instead of truncating', () => {
    // Silently truncating to 0 is how a real deposit gets lost.
    expect(() => parseUnits('0.0000001', 6)).toThrow(MoneyError);
    expect(() => parseUnits('1.999', 2)).toThrow(/2 decimal places|supports 2/);
  });

  it('rejects non-string input because numbers lose precision', () => {
    expect(() => parseUnits(0.1 as unknown as string, 18)).toThrow(MoneyError);
    expect(() => parseUnits(100 as unknown as string, 6)).toThrow(/must be a string/);
  });

  it.each([
    '',
    '   ',
    'abc',
    '1e18',
    '1_000',
    '1,000.00',
    '0x10',
    '1.2.3',
    '.5',
    '5.',
    'Infinity',
    'NaN',
  ])('rejects malformed input %j', (input) => {
    expect(() => parseUnits(input, 6)).toThrow(MoneyError);
  });

  it('rejects an out-of-range decimals argument', () => {
    expect(() => parseUnits('1', -1)).toThrow(MoneyError);
    expect(() => parseUnits('1', 1.5)).toThrow(MoneyError);
    expect(() => parseUnits('1', 99)).toThrow(MoneyError);
  });
});

describe('formatUnits', () => {
  it('renders full precision, keeping trailing zeros', () => {
    expect(formatUnits(100_000_000n, 6)).toBe('100.000000');
    expect(formatUnits(1n, 8)).toBe('0.00000001');
    expect(formatUnits(0n, 6)).toBe('0.000000');
  });

  it('renders negatives correctly', () => {
    expect(formatUnits(-2550n, 2)).toBe('-25.50');
    expect(formatUnits(-1n, 6)).toBe('-0.000001');
  });

  it('renders zero-decimal assets without a separator', () => {
    expect(formatUnits(1500n, 0)).toBe('1500');
  });

  it('round-trips with parseUnits', () => {
    const cases: Array<[string, number]> = [
      ['0.000001', 6],
      ['123456789.123456789012345678', 18],
      ['-0.00000001', 8],
      ['0.00', 2],
    ];
    for (const [value, decimals] of cases) {
      expect(formatUnits(parseUnits(value, decimals), decimals)).toBe(value);
    }
  });

  it('trims only for display', () => {
    expect(formatUnitsTrimmed(100_000_000n, 6)).toBe('100');
    expect(formatUnitsTrimmed(1_500_000n, 6)).toBe('1.5');
    expect(formatUnitsTrimmed(0n, 6)).toBe('0');
  });
});

describe('rounding helpers', () => {
  it('divFloor rounds toward negative infinity', () => {
    expect(divFloor(7n, 2n)).toBe(3n);
    expect(divFloor(-7n, 2n)).toBe(-4n);
    expect(divFloor(6n, 2n)).toBe(3n);
  });

  it('divCeil rounds toward positive infinity', () => {
    expect(divCeil(7n, 2n)).toBe(4n);
    expect(divCeil(-7n, 2n)).toBe(-3n);
    expect(divCeil(6n, 2n)).toBe(3n);
  });

  it('divHalfUp rounds halves away from zero', () => {
    expect(divHalfUp(5n, 2n)).toBe(3n);
    expect(divHalfUp(-5n, 2n)).toBe(-3n);
    expect(divHalfUp(4n, 3n)).toBe(1n);
    expect(divHalfUp(5n, 3n)).toBe(2n);
  });

  it('refuses division by zero', () => {
    expect(() => divFloor(1n, 0n)).toThrow(MoneyError);
    expect(() => divCeil(1n, 0n)).toThrow(MoneyError);
    expect(() => divHalfUp(1n, 0n)).toThrow(MoneyError);
  });
});

describe('rescaleUnits', () => {
  it('scales up without loss', () => {
    // 1 USDT at 6 dp -> the same value expressed at 18 dp.
    expect(rescaleUnits(1_000_000n, 6, 18)).toBe(1_000_000_000_000_000_000n);
  });

  it('scales down with the requested rounding', () => {
    // 1.5e12 wei-scale units == 1.5 units at 6 dp.
    expect(rescaleUnits(1_500_000_000_000n, 18, 6, 'floor')).toBe(1n);
    expect(rescaleUnits(1_500_000_000_000n, 18, 6, 'ceil')).toBe(2n);
    expect(rescaleUnits(1_500_000_000_000n, 18, 6, 'half-up')).toBe(2n);
    // Exactly half a unit.
    expect(rescaleUnits(500_000_000_000n, 18, 6, 'half-up')).toBe(1n);
    expect(rescaleUnits(499_999_999_999n, 18, 6, 'half-up')).toBe(0n);
  });

  it('can round a sub-unit remainder away entirely', () => {
    // Anything below 1e12 wei-scale is less than one 6-dp unit.
    expect(rescaleUnits(999_999_999_999n, 18, 6, 'floor')).toBe(0n);
    expect(rescaleUnits(1n, 18, 6, 'ceil')).toBe(1n);
  });

  it('is a no-op at equal precision', () => {
    expect(rescaleUnits(12345n, 6, 6)).toBe(12345n);
  });
});
