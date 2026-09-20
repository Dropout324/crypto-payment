import { Money } from '@gateway/shared';
import { Prisma } from '@prisma/client';

/**
 * The bigint <-> NUMERIC(78,0) boundary.
 *
 * Every monetary column is an exact integer count of an asset's smallest
 * units. Prisma hands those back as Decimal objects, so this module is the ONLY
 * place that converts between the two - and it refuses anything that is not an
 * exact integer rather than rounding it away.
 */

export class MoneyMappingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyMappingError';
  }
}

/** Read a NUMERIC(78,0) column as smallest units. */
export function decimalToUnits(value: Prisma.Decimal | null | undefined): bigint {
  if (value === null || value === undefined) {
    throw new MoneyMappingError('expected a numeric amount, received null');
  }

  const text = value.toFixed();
  if (!/^-?\d+$/.test(text)) {
    // A fractional value in a smallest-units column means something upstream
    // wrote a float. Surface it loudly instead of truncating.
    throw new MoneyMappingError(
      `monetary column holds a non-integer value: ${text}. Smallest units must be whole numbers.`,
    );
  }

  return BigInt(text);
}

export function decimalToUnitsOrNull(value: Prisma.Decimal | null | undefined): bigint | null {
  return value === null || value === undefined ? null : decimalToUnits(value);
}

/**
 * Write smallest units into a NUMERIC(78,0) column.
 *
 * Passed as a string: routing a bigint through Number would silently lose
 * precision above 2^53.
 */
export function unitsToDecimal(units: bigint): Prisma.Decimal {
  return new Prisma.Decimal(units.toString());
}

export function unitsToDecimalOrNull(units: bigint | null | undefined): Prisma.Decimal | null {
  return units === null || units === undefined ? null : unitsToDecimal(units);
}

/** Rebuild a Money value from a row's amount plus its asset columns. */
export function toMoney(
  value: Prisma.Decimal | null | undefined,
  asset: string,
  decimals: number,
): Money {
  return Money.fromUnits(decimalToUnits(value), asset, decimals);
}

export function toMoneyOrNull(
  value: Prisma.Decimal | null | undefined,
  asset: string,
  decimals: number,
): Money | null {
  const units = decimalToUnitsOrNull(value);
  return units === null ? null : Money.fromUnits(units, asset, decimals);
}

export function fromMoney(money: Money): Prisma.Decimal {
  return unitsToDecimal(money.units);
}

/** Exchange rates are stored scaled by 1e18 in the same NUMERIC(78,0) form. */
export function decimalToRateNumerator(value: Prisma.Decimal | null | undefined): bigint | null {
  return decimalToUnitsOrNull(value);
}

export function rateNumeratorToDecimal(numerator: bigint): Prisma.Decimal {
  return unitsToDecimal(numerator);
}

/** Block numbers cross the boundary as bigint, never as Number. */
export function toBlockNumber(value: bigint | null | undefined): bigint | null {
  return value === null || value === undefined ? null : value;
}
