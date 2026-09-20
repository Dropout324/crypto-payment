import { ExchangeRate } from '@gateway/shared';
import { describe, expect, it, vi } from 'vitest';
import { type ExchangeRateProvider, ExchangeRateProviderError } from '../src/provider.js';
import { ExchangeRateService, RateStaleError, RateUnavailableError } from '../src/service.js';

function fakeProvider(
  name: string,
  impl: (base: string, quote: string) => Promise<ExchangeRate>,
): ExchangeRateProvider {
  return { name, getRate: impl };
}

function rateAt(base: string, quote: string, value: string, observedAt: Date, provider = 'test'): ExchangeRate {
  return ExchangeRate.fromDecimal({ base, quote, rate: value, provider, observedAt });
}

describe('ExchangeRateService: happy path', () => {
  it('returns the primary provider result when it succeeds', async () => {
    const primary = fakeProvider('primary', async (b, q) => rateAt(b, q, '65000', new Date()));
    const service = new ExchangeRateService({ providers: [primary] });

    const rate = await service.getRate('BTC', 'USD');
    expect(rate.provider).toBe('test');
    expect(rate.toDecimalString()).toBe('65000.000000000000000000');
  });

  it('short-circuits to a 1:1 identity rate when base equals quote', async () => {
    const provider = fakeProvider('primary', vi.fn());
    const service = new ExchangeRateService({ providers: [provider] });
    const rate = await service.getRate('USDT', 'USDT');
    expect(rate.toDecimalString()).toBe('1.000000000000000000');
  });
});

describe('ExchangeRateService: fallback', () => {
  it('falls back to the next provider when the first fails', async () => {
    const primary = fakeProvider('primary', async () => {
      throw new ExchangeRateProviderError('primary', 'timed out');
    });
    const fallback = fakeProvider('fallback', async (b, q) => rateAt(b, q, '3000', new Date()));

    const service = new ExchangeRateService({ providers: [primary, fallback] });
    const rate = await service.getRate('ETH', 'USD');
    expect(rate.provider).toBe('test');
    expect(rate.toDecimalString()).toBe('3000.000000000000000000');
  });

  it('throws RateUnavailableError with every attempt recorded when all providers fail', async () => {
    const primary = fakeProvider('primary', async () => {
      throw new ExchangeRateProviderError('primary', 'boom-1');
    });
    const fallback = fakeProvider('fallback', async () => {
      throw new ExchangeRateProviderError('fallback', 'boom-2');
    });

    const service = new ExchangeRateService({ providers: [primary, fallback] });
    await expect(service.getRate('ETH', 'USD')).rejects.toThrow(RateUnavailableError);

    try {
      await service.getRate('ETH', 'USD');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(RateUnavailableError);
      const details = (error as RateUnavailableError).details as { attempts: unknown[] };
      expect(details.attempts).toHaveLength(2);
    }
  });

  it('still tries a later provider after a non-retryable failure', async () => {
    const primary = fakeProvider('primary', async () => {
      throw new ExchangeRateProviderError('primary', 'unsupported pair', { retryable: false });
    });
    const fallback = fakeProvider('fallback', async (b, q) => rateAt(b, q, '1', new Date()));

    const service = new ExchangeRateService({ providers: [primary, fallback] });
    await expect(service.getRate('X', 'Y')).resolves.toBeDefined();
  });

  it('still tries a later provider after a plain, unwrapped error', async () => {
    const primary = fakeProvider('primary', async () => {
      throw new TypeError('network request failed');
    });
    const fallback = fakeProvider('fallback', async (b, q) => rateAt(b, q, '1', new Date()));

    const service = new ExchangeRateService({ providers: [primary, fallback] });
    const rate = await service.getRate('ETH', 'USD');
    expect(rate.toDecimalString()).toBe('1.000000000000000000');
  });
});

describe('ExchangeRateService: staleness', () => {
  it('rejects a rate a provider returns already stale', async () => {
    const stale = fakeProvider('stale', async (b, q) =>
      rateAt(b, q, '65000', new Date(Date.now() - 10 * 60_000)),
    );
    const service = new ExchangeRateService({ providers: [stale], maxAgeMs: 120_000 });
    await expect(service.getRate('BTC', 'USD')).rejects.toThrow(RateStaleError);
  });

  it('does not fall through to another provider on a stale (not failed) rate', async () => {
    const stale = fakeProvider('stale', async (b, q) => rateAt(b, q, '1', new Date(Date.now() - 600_000)));
    const other = fakeProvider('other', vi.fn());
    const service = new ExchangeRateService({ providers: [stale, other], maxAgeMs: 60_000 });

    await expect(service.getRate('BTC', 'USD')).rejects.toThrow(RateStaleError);
    expect(other.getRate).not.toHaveBeenCalled();
  });
});

describe('ExchangeRateService: caching', () => {
  it('serves a repeated request from cache without calling the provider again', async () => {
    let now = new Date('2026-01-01T00:00:00Z');
    const getRate = vi.fn(async (b: string, q: string) => rateAt(b, q, '65000', now));
    const provider = fakeProvider('primary', getRate);

    const service = new ExchangeRateService({ providers: [provider], cacheTtlMs: 30_000, now: () => now });

    await service.getRate('BTC', 'USD');
    await service.getRate('BTC', 'USD');
    expect(getRate).toHaveBeenCalledTimes(1);

    now = new Date(now.getTime() + 31_000);
    await service.getRate('BTC', 'USD');
    expect(getRate).toHaveBeenCalledTimes(2);
  });

  it('coalesces concurrent requests for the same pair into a single provider call', async () => {
    let resolveProvider: (rate: ExchangeRate) => void = () => {};
    const getRate = vi.fn(
      () =>
        new Promise<ExchangeRate>((resolve) => {
          resolveProvider = resolve;
        }),
    );
    const provider = fakeProvider('primary', getRate);
    const service = new ExchangeRateService({ providers: [provider] });

    const first = service.getRate('BTC', 'USD');
    const second = service.getRate('BTC', 'USD');

    resolveProvider(rateAt('BTC', 'USD', '65000', new Date()));

    const [a, b] = await Promise.all([first, second]);
    expect(a.equals ? true : true).toBe(true); // sanity: both resolved
    expect(getRate).toHaveBeenCalledTimes(1);
    expect(a.toDecimalString()).toBe(b.toDecimalString());
  });

  it('clearCache forces a fresh provider call', async () => {
    const getRate = vi.fn(async (b: string, q: string) => rateAt(b, q, '65000', new Date()));
    const provider = fakeProvider('primary', getRate);
    const service = new ExchangeRateService({ providers: [provider] });

    await service.getRate('BTC', 'USD');
    service.clearCache();
    await service.getRate('BTC', 'USD');
    expect(getRate).toHaveBeenCalledTimes(2);
  });

  it('does not serve a cached rate that has since gone stale', async () => {
    let now = new Date('2026-01-01T00:00:00Z');
    const getRate = vi.fn(async (b: string, q: string) => rateAt(b, q, '65000', now));
    const provider = fakeProvider('primary', getRate);

    // Cache TTL longer than the staleness limit: the cache would happily serve
    // it, but staleness must still be re-checked on every read.
    const service = new ExchangeRateService({
      providers: [provider],
      cacheTtlMs: 600_000,
      maxAgeMs: 60_000,
      now: () => now,
    });

    await service.getRate('BTC', 'USD');
    now = new Date(now.getTime() + 120_000);
    await expect(service.getRate('BTC', 'USD')).rejects.toThrow(RateStaleError);
  });
});

describe('ExchangeRateService: symbol normalisation', () => {
  it('treats differently-cased asset symbols as the same cache key', async () => {
    const getRate = vi.fn(async (b: string, q: string) => rateAt(b, q, '65000', new Date()));
    const provider = fakeProvider('primary', getRate);
    const service = new ExchangeRateService({ providers: [provider] });

    await service.getRate('btc', 'usd');
    await service.getRate('BTC', 'USD');

    expect(getRate).toHaveBeenCalledTimes(1);
  });
});

describe('ExchangeRateService: construction', () => {
  it('refuses to start with zero providers', () => {
    expect(() => new ExchangeRateService({ providers: [] })).toThrow(/at least one provider/);
  });
});
