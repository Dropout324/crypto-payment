import {
  MoneyError,
  type RoundingMode,
  absUnits,
  formatUnits,
  formatUnitsTrimmed,
  parseUnits,
  rescaleUnits,
} from './decimal.js';

/**
 * An amount of one specific asset, held as smallest units.
 *
 * The asset code and its decimal precision travel WITH the amount so that a
 * USDT amount can never be added to an ETH amount, and a 6-decimal value can
 * never be silently reinterpreted as an 18-decimal one.
 */
export class Money {
  readonly units: bigint;
  readonly asset: string;
  readonly decimals: number;

  private constructor(units: bigint, asset: string, decimals: number) {
    this.units = units;
    this.asset = asset;
    this.decimals = decimals;
    Object.freeze(this);
  }

  static fromUnits(units: bigint, asset: string, decimals: number): Money {
    if (typeof units !== 'bigint') {
      throw new MoneyError('Money.fromUnits requires a bigint');
    }
    return new Money(units, asset, decimals);
  }

  static fromDecimal(value: string, asset: string, decimals: number): Money {
    return new Money(parseUnits(value, decimals), asset, decimals);
  }

  static zero(asset: string, decimals: number): Money {
    return new Money(0n, asset, decimals);
  }

  private assertSameAsset(other: Money): void {
    if (this.asset !== other.asset || this.decimals !== other.decimals) {
      throw new MoneyError(
        `cannot combine ${this.asset}(${this.decimals}) with ${other.asset}(${other.decimals})`,
      );
    }
  }

  add(other: Money): Money {
    this.assertSameAsset(other);
    return new Money(this.units + other.units, this.asset, this.decimals);
  }

  subtract(other: Money): Money {
    this.assertSameAsset(other);
    return new Money(this.units - other.units, this.asset, this.decimals);
  }

  /** Multiply by an integer factor (e.g. a transaction count), never a float. */
  multiplyInteger(factor: bigint): Money {
    return new Money(this.units * factor, this.asset, this.decimals);
  }

  /**
   * Apply a rational factor `numerator / denominator` — the only supported way
   * to take a percentage (fees, tolerances), because it stays in integer math.
   */
  multiplyRatio(numerator: bigint, denominator: bigint, mode: RoundingMode = 'half-up'): Money {
    if (denominator === 0n) throw new MoneyError('denominator must not be zero');
    const product = this.units * numerator;
    const scaled =
      mode === 'floor'
        ? floorDiv(product, denominator)
        : mode === 'ceil'
          ? ceilDiv(product, denominator)
          : halfUpDiv(product, denominator);
    return new Money(scaled, this.asset, this.decimals);
  }

  /** Basis points: 25 bps = 0.25%. Rounds half-up by default. */
  percentageBps(bps: number, mode: RoundingMode = 'half-up'): Money {
    if (!Number.isInteger(bps)) throw new MoneyError('bps must be an integer');
    return this.multiplyRatio(BigInt(bps), 10_000n, mode);
  }

  compare(other: Money): -1 | 0 | 1 {
    this.assertSameAsset(other);
    if (this.units < other.units) return -1;
    if (this.units > other.units) return 1;
    return 0;
  }

  equals(other: Money): boolean {
    return this.asset === other.asset && this.decimals === other.decimals && this.units === other.units;
  }

  greaterThan(other: Money): boolean {
    return this.compare(other) === 1;
  }

  greaterThanOrEqual(other: Money): boolean {
    return this.compare(other) >= 0;
  }

  lessThan(other: Money): boolean {
    return this.compare(other) === -1;
  }

  lessThanOrEqual(other: Money): boolean {
    return this.compare(other) <= 0;
  }

  get isZero(): boolean {
    return this.units === 0n;
  }

  get isPositive(): boolean {
    return this.units > 0n;
  }

  get isNegative(): boolean {
    return this.units < 0n;
  }

  abs(): Money {
    return new Money(absUnits(this.units), this.asset, this.decimals);
  }

  negate(): Money {
    return new Money(-this.units, this.asset, this.decimals);
  }

  /** Reinterpret this amount at a different precision for the same asset. */
  withDecimals(decimals: number, mode: RoundingMode = 'half-up'): Money {
    return new Money(rescaleUnits(this.units, this.decimals, decimals, mode), this.asset, decimals);
  }

  toDecimalString(): string {
    return formatUnits(this.units, this.decimals);
  }

  toTrimmedString(): string {
    return formatUnitsTrimmed(this.units, this.decimals);
  }

  /** Persistence / transport shape. `units` is a string: JSON has no bigint. */
  toJSON(): { units: string; asset: string; decimals: number; amount: string } {
    return {
      units: this.units.toString(),
      asset: this.asset,
      decimals: this.decimals,
      amount: this.toDecimalString(),
    };
  }

  toString(): string {
    return `${this.toDecimalString()} ${this.asset}`;
  }
}

function floorDiv(numerator: bigint, denominator: bigint): bigint {
  const quotient = numerator / denominator;
  const negative = numerator < 0n !== denominator < 0n;
  return negative && numerator % denominator !== 0n ? quotient - 1n : quotient;
}

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  const quotient = numerator / denominator;
  const positive = numerator < 0n === denominator < 0n;
  return positive && numerator % denominator !== 0n ? quotient + 1n : quotient;
}

function halfUpDiv(numerator: bigint, denominator: bigint): bigint {
  const negative = numerator < 0n !== denominator < 0n;
  const absN = numerator < 0n ? -numerator : numerator;
  const absD = denominator < 0n ? -denominator : denominator;
  const quotient = absN / absD;
  const remainder = absN % absD;
  const rounded = remainder * 2n >= absD ? quotient + 1n : quotient;
  return negative ? -rounded : rounded;
}
