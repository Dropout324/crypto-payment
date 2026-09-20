/**
 * Integer-only fixed-point arithmetic.
 *
 * ENGINEERING RULE #6: money is NEVER represented as a JavaScript `number`.
 * Every value in this module is a `bigint` of the asset's smallest indivisible
 * unit (satoshi, wei, USDT micro-unit...). Decimal strings exist only at the
 * boundary of the system: parsed on the way in, formatted on the way out.
 */

/** How to resolve a division that does not come out exact. */
export type RoundingMode = 'floor' | 'ceil' | 'half-up';

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyError';
  }
}

const DECIMAL_PATTERN = /^-?\d+(\.\d+)?$/;

/** Highest number of decimals we accept anywhere (wei-scale assets use 18). */
export const MAX_DECIMALS = 36;

function assertDecimals(decimals: number): void {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > MAX_DECIMALS) {
    throw new MoneyError(
      `decimals must be an integer in [0, ${MAX_DECIMALS}], received ${decimals}`,
    );
  }
}

/** 10n ** exponent, with the exponent validated as a safe small integer. */
export function pow10(exponent: number): bigint {
  if (!Number.isInteger(exponent) || exponent < 0 || exponent > MAX_DECIMALS * 2) {
    throw new MoneyError(`pow10 exponent out of range: ${exponent}`);
  }
  return 10n ** BigInt(exponent);
}

/**
 * Parse a decimal string into smallest units.
 *
 * Deliberately strict: rejects `number` inputs, scientific notation, thousands
 * separators, empty strings, and any value with more decimal places than the
 * asset supports. Silently truncating "0.0000001 BTC" to zero is exactly the
 * class of bug that loses customer funds, so it raises instead.
 */
export function parseUnits(value: string, decimals: number): bigint {
  assertDecimals(decimals);

  if (typeof value !== 'string') {
    throw new MoneyError('amount must be a string; numbers lose precision');
  }

  const trimmed = value.trim();
  if (trimmed === '' || !DECIMAL_PATTERN.test(trimmed)) {
    throw new MoneyError(`invalid decimal amount: "${value}"`);
  }

  const negative = trimmed.startsWith('-');
  const unsigned = negative ? trimmed.slice(1) : trimmed;
  const [wholePart = '0', fractionPart = ''] = unsigned.split('.');

  if (fractionPart.length > decimals) {
    throw new MoneyError(
      `amount "${value}" has ${fractionPart.length} decimal places but the asset supports ${decimals}`,
    );
  }

  const padded = fractionPart.padEnd(decimals, '0');
  const units = BigInt(wholePart) * pow10(decimals) + BigInt(padded === '' ? '0' : padded);

  return negative ? -units : units;
}

/**
 * Render smallest units as a decimal string.
 *
 * Always emits every decimal place the asset defines (`1000000` USDT units ->
 * `"1.000000"`), so a formatted value round-trips through `parseUnits` exactly.
 */
export function formatUnits(units: bigint, decimals: number): string {
  assertDecimals(decimals);

  if (decimals === 0) return units.toString();

  const negative = units < 0n;
  const absolute = negative ? -units : units;
  const divisor = pow10(decimals);

  const whole = absolute / divisor;
  const fraction = (absolute % divisor).toString().padStart(decimals, '0');

  return `${negative ? '-' : ''}${whole}.${fraction}`;
}

/** Same as `formatUnits` but drops trailing zeros for display purposes only. */
export function formatUnitsTrimmed(units: bigint, decimals: number): string {
  const formatted = formatUnits(units, decimals);
  if (!formatted.includes('.')) return formatted;
  return formatted.replace(/\.?0+$/, '');
}

/** Integer division rounding toward negative infinity. */
export function divFloor(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new MoneyError('division by zero');
  const quotient = numerator / denominator;
  const hasRemainder = numerator % denominator !== 0n;
  const negativeResult = numerator < 0n !== denominator < 0n;
  return hasRemainder && negativeResult ? quotient - 1n : quotient;
}

/** Integer division rounding toward positive infinity. */
export function divCeil(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new MoneyError('division by zero');
  const quotient = numerator / denominator;
  const hasRemainder = numerator % denominator !== 0n;
  const positiveResult = numerator < 0n === denominator < 0n;
  return hasRemainder && positiveResult ? quotient + 1n : quotient;
}

/** Integer division rounding halves away from zero. */
export function divHalfUp(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new MoneyError('division by zero');

  const negativeResult = numerator < 0n !== denominator < 0n;
  const absNumerator = numerator < 0n ? -numerator : numerator;
  const absDenominator = denominator < 0n ? -denominator : denominator;

  const quotient = absNumerator / absDenominator;
  const remainder = absNumerator % absDenominator;
  const rounded = remainder * 2n >= absDenominator ? quotient + 1n : quotient;

  return negativeResult ? -rounded : rounded;
}

export function divide(
  numerator: bigint,
  denominator: bigint,
  mode: RoundingMode,
): bigint {
  switch (mode) {
    case 'floor':
      return divFloor(numerator, denominator);
    case 'ceil':
      return divCeil(numerator, denominator);
    case 'half-up':
      return divHalfUp(numerator, denominator);
    default: {
      const exhaustive: never = mode;
      throw new MoneyError(`unknown rounding mode: ${String(exhaustive)}`);
    }
  }
}

/** Rescale a units value from one decimal precision to another. */
export function rescaleUnits(
  units: bigint,
  fromDecimals: number,
  toDecimals: number,
  mode: RoundingMode = 'half-up',
): bigint {
  assertDecimals(fromDecimals);
  assertDecimals(toDecimals);

  if (fromDecimals === toDecimals) return units;
  if (toDecimals > fromDecimals) return units * pow10(toDecimals - fromDecimals);
  return divide(units, pow10(fromDecimals - toDecimals), mode);
}

export function absUnits(units: bigint): bigint {
  return units < 0n ? -units : units;
}

export function minUnits(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

export function maxUnits(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}
