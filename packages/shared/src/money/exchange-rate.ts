import { MoneyError, type RoundingMode, divide, parseUnits, pow10 } from './decimal.js';
import { Money } from './money.js';

/** Precision every rate is normalised to internally (18 dp, wei-grade). */
export const RATE_SCALE = 18;

/**
 * An immutable price observation: how much of `quote` one whole unit of `base`
 * is worth, e.g. base=ETH quote=USD numerator=3000_550000... at scale 18.
 *
 * SPEC §27: once an invoice stores a rate it is frozen. Historical invoices are
 * never re-priced, so this object carries the provenance (`provider`,
 * `observedAt`) needed to audit the number long after the fact.
 */
export class ExchangeRate {
  readonly base: string;
  readonly quote: string;
  /** Rate value scaled by 10^RATE_SCALE. */
  readonly numerator: bigint;
  readonly provider: string;
  readonly observedAt: Date;

  private constructor(
    base: string,
    quote: string,
    numerator: bigint,
    provider: string,
    observedAt: Date,
  ) {
    if (numerator <= 0n) {
      throw new MoneyError(`exchange rate must be positive, received ${numerator}`);
    }
    this.base = base;
    this.quote = quote;
    this.numerator = numerator;
    this.provider = provider;
    this.observedAt = new Date(observedAt.getTime());
    Object.freeze(this);
  }

  static fromDecimal(params: {
    base: string;
    quote: string;
    rate: string;
    provider: string;
    observedAt: Date;
  }): ExchangeRate {
    return new ExchangeRate(
      params.base,
      params.quote,
      parseUnits(params.rate, RATE_SCALE),
      params.provider,
      params.observedAt,
    );
  }

  static fromScaledNumerator(params: {
    base: string;
    quote: string;
    numerator: bigint;
    provider: string;
    observedAt: Date;
  }): ExchangeRate {
    return new ExchangeRate(
      params.base,
      params.quote,
      params.numerator,
      params.provider,
      params.observedAt,
    );
  }

  /** A 1:1 rate, used when the invoice currency IS the payment asset. */
  static identity(asset: string, provider = 'identity', observedAt = new Date()): ExchangeRate {
    return new ExchangeRate(asset, asset, pow10(RATE_SCALE), provider, observedAt);
  }

  get ageMs(): number {
    return Date.now() - this.observedAt.getTime();
  }

  isStale(maxAgeMs: number): boolean {
    return this.ageMs > maxAgeMs;
  }

  toDecimalString(): string {
    const divisor = pow10(RATE_SCALE);
    const whole = this.numerator / divisor;
    const fraction = (this.numerator % divisor).toString().padStart(RATE_SCALE, '0');
    return `${whole}.${fraction}`;
  }

  /**
   * Price a `quote`-denominated amount in `base` units — the invoice path
   * ("charge 100.00 USD, collect X USDT").
   *
   * Rounds UP by default: rounding down would let the customer settle a
   * 100.00 USD invoice for 99.999999 USD of crypto and still be marked paid.
   * The sub-unit difference is the customer's, never the merchant's.
   */
  convertQuoteToBase(
    amount: Money,
    baseDecimals: number,
    mode: RoundingMode = 'ceil',
  ): Money {
    if (amount.asset !== this.quote) {
      throw new MoneyError(
        `rate ${this.base}/${this.quote} cannot price an amount denominated in ${amount.asset}`,
      );
    }

    const numerator = amount.units * pow10(baseDecimals) * pow10(RATE_SCALE);
    const denominator = pow10(amount.decimals) * this.numerator;

    return Money.fromUnits(divide(numerator, denominator, mode), this.base, baseDecimals);
  }

  /**
   * Value a `base` amount in `quote` — the reporting/settlement path
   * ("this 0.05 ETH deposit was worth N USD at invoice time").
   */
  convertBaseToQuote(
    amount: Money,
    quoteDecimals: number,
    mode: RoundingMode = 'half-up',
  ): Money {
    if (amount.asset !== this.base) {
      throw new MoneyError(
        `rate ${this.base}/${this.quote} cannot value an amount denominated in ${amount.asset}`,
      );
    }

    const numerator = amount.units * this.numerator * pow10(quoteDecimals);
    const denominator = pow10(RATE_SCALE) * pow10(amount.decimals);

    return Money.fromUnits(divide(numerator, denominator, mode), this.quote, quoteDecimals);
  }

  toJSON(): {
    base: string;
    quote: string;
    rate: string;
    numerator: string;
    scale: number;
    provider: string;
    observedAt: string;
  } {
    return {
      base: this.base,
      quote: this.quote,
      rate: this.toDecimalString(),
      numerator: this.numerator.toString(),
      scale: RATE_SCALE,
      provider: this.provider,
      observedAt: this.observedAt.toISOString(),
    };
  }
}
