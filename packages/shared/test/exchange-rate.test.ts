import { describe, expect, it } from 'vitest';
import { MoneyError } from '../src/money/decimal.js';
import { ExchangeRate } from '../src/money/exchange-rate.js';
import { Money } from '../src/money/money.js';

const observedAt = new Date('2026-09-08T00:00:00.000Z');

function rate(base: string, quote: string, value: string): ExchangeRate {
  return ExchangeRate.fromDecimal({ base, quote, rate: value, provider: 'test', observedAt });
}

const usd = (value: string) => Money.fromDecimal(value, 'USD', 2);

describe('ExchangeRate pricing an invoice', () => {
  it('prices a USD invoice in USDT at parity', () => {
    const usdtUsd = rate('USDT', 'USD', '1.00');
    const crypto = usdtUsd.convertQuoteToBase(usd('100.00'), 6);
    expect(crypto.asset).toBe('USDT');
    expect(crypto.toDecimalString()).toBe('100.000000');
  });

  it('prices a USD invoice in ETH at 18 decimals', () => {
    const ethUsd = rate('ETH', 'USD', '3000.00');
    const crypto = ethUsd.convertQuoteToBase(usd('150.00'), 18);
    expect(crypto.toDecimalString()).toBe('0.050000000000000000');
  });

  it('rounds the collectable amount UP so the merchant is never short', () => {
    // 100.00 USD at 3.00 USD/TOKEN = 33.333... TOKEN
    const tokenUsd = rate('TOKEN', 'USD', '3.00');
    const crypto = tokenUsd.convertQuoteToBase(usd('100.00'), 6);
    expect(crypto.toDecimalString()).toBe('33.333334');

    // Valued back, the rounded-up amount is >= the invoice.
    const backToUsd = tokenUsd.convertBaseToQuote(crypto, 2);
    expect(backToUsd.greaterThanOrEqual(usd('100.00'))).toBe(true);
  });

  it('prices a sub-cent charge in satoshi', () => {
    // 0.01 USD / 100000 USD-per-BTC = 1e-7 BTC = 10 satoshi, exactly.
    const expensive = rate('BTC', 'USD', '100000.00');
    expect(expensive.convertQuoteToBase(usd('0.01'), 8).units).toBe(10n);
  });

  it('never rounds a non-zero charge down to zero', () => {
    // At an absurd price, 0.01 USD is a millionth of a satoshi - it must still
    // round up to 1 unit rather than produce a free invoice.
    const absurd = rate('BTC', 'USD', '1000000000000.00');
    const crypto = absurd.convertQuoteToBase(usd('0.01'), 8);
    expect(crypto.units).toBe(1n);
    expect(crypto.isPositive).toBe(true);
  });

  it('handles a zero-decimal invoice currency', () => {
    const btcJpy = rate('BTC', 'JPY', '15000000');
    const crypto = btcJpy.convertQuoteToBase(Money.fromDecimal('150000', 'JPY', 0), 8);
    expect(crypto.toDecimalString()).toBe('0.01000000');
  });

  it('refuses to price an amount denominated in the wrong currency', () => {
    const ethUsd = rate('ETH', 'USD', '3000.00');
    expect(() => ethUsd.convertQuoteToBase(Money.fromDecimal('100', 'EUR', 2), 18)).toThrow(
      MoneyError,
    );
  });
});

describe('ExchangeRate valuing a receipt', () => {
  it('values a crypto amount back into fiat', () => {
    const ethUsd = rate('ETH', 'USD', '3000.00');
    const value = ethUsd.convertBaseToQuote(Money.fromDecimal('0.05', 'ETH', 18), 2);
    expect(value.toDecimalString()).toBe('150.00');
  });

  it('refuses to value an amount of a different asset', () => {
    const ethUsd = rate('ETH', 'USD', '3000.00');
    expect(() => ethUsd.convertBaseToQuote(Money.fromDecimal('1', 'BTC', 8), 2)).toThrow(
      MoneyError,
    );
  });
});

describe('ExchangeRate invariants', () => {
  it('is immutable and defensively copies its timestamp', () => {
    const r = rate('ETH', 'USD', '3000.00');
    expect(Object.isFrozen(r)).toBe(true);
    r.observedAt.setFullYear(1999);
    expect(r.observedAt.getUTCFullYear()).toBe(1999); // the copy the caller mutated
    expect(observedAt.getUTCFullYear()).toBe(2026); // the original is untouched
  });

  it('rejects a non-positive rate', () => {
    expect(() => rate('ETH', 'USD', '0')).toThrow(MoneyError);
    expect(() => rate('ETH', 'USD', '-1')).toThrow(MoneyError);
  });

  it('detects a stale price', () => {
    const fresh = ExchangeRate.fromDecimal({
      base: 'ETH',
      quote: 'USD',
      rate: '3000.00',
      provider: 'test',
      observedAt: new Date(),
    });
    expect(fresh.isStale(60_000)).toBe(false);

    const old = ExchangeRate.fromDecimal({
      base: 'ETH',
      quote: 'USD',
      rate: '3000.00',
      provider: 'test',
      observedAt: new Date(Date.now() - 120_000),
    });
    expect(old.isStale(60_000)).toBe(true);
  });

  it('preserves an exact decimal representation for the audit trail', () => {
    const r = rate('ETH', 'USD', '3000.123456789012345678');
    expect(r.toDecimalString()).toBe('3000.123456789012345678');
    expect(r.toJSON()).toMatchObject({
      base: 'ETH',
      quote: 'USD',
      rate: '3000.123456789012345678',
      scale: 18,
      provider: 'test',
      observedAt: '2026-09-08T00:00:00.000Z',
    });
  });

  it('identity rate converts 1:1', () => {
    const identity = ExchangeRate.identity('USDT');
    const result = identity.convertQuoteToBase(Money.fromDecimal('100', 'USDT', 6), 6);
    expect(result.toDecimalString()).toBe('100.000000');
  });
});
