import { describe, expect, it, vi } from 'vitest';
import { BinanceProvider } from '../src/providers/binance.js';
import { CoinGeckoProvider } from '../src/providers/coingecko.js';
import { ExchangeRateProviderError } from '../src/provider.js';

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body };
}

describe('CoinGeckoProvider', () => {
  it('parses a successful price response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ bitcoin: { usd: 65000.5 } }));
    const provider = new CoinGeckoProvider({ fetchImpl });

    const rate = await provider.getRate('BTC', 'USD');
    expect(rate.base).toBe('BTC');
    expect(rate.quote).toBe('USD');
    expect(rate.toDecimalString()).toBe('65000.500000000000000000');
    expect(rate.provider).toBe('coingecko');

    const url = fetchImpl.mock.calls[0]?.[0] as string;
    expect(url).toContain('ids=bitcoin');
    expect(url).toContain('vs_currencies=usd');
  });

  it('rejects an unmapped base asset without calling the network', async () => {
    const fetchImpl = vi.fn();
    const provider = new CoinGeckoProvider({ fetchImpl });
    await expect(provider.getRate('DOGE', 'USD')).rejects.toThrow(ExchangeRateProviderError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('throws a retryable error when the price is missing from the response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ bitcoin: {} }));
    const provider = new CoinGeckoProvider({ fetchImpl });
    await expect(provider.getRate('BTC', 'USD')).rejects.toMatchObject({ retryable: true });
  });

  it('surfaces an HTTP error as retryable for 5xx and 429', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}, false, 503));
    const provider = new CoinGeckoProvider({ fetchImpl });
    await expect(provider.getRate('BTC', 'USD')).rejects.toMatchObject({ retryable: true });
  });

  it('aborts on timeout', async () => {
    const fetchImpl = vi.fn((_url: string, init?: { signal?: AbortSignal }) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    });
    const provider = new CoinGeckoProvider({ fetchImpl, timeoutMs: 10 });
    await expect(provider.getRate('BTC', 'USD')).rejects.toThrow(ExchangeRateProviderError);
  });
});

describe('BinanceProvider', () => {
  it('parses a ticker price response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ symbol: 'ETHUSDT', price: '3000.12345678' }));
    const provider = new BinanceProvider({ fetchImpl });

    const rate = await provider.getRate('ETH', 'USD');
    expect(rate.toDecimalString()).toBe('3000.123456780000000000');

    const url = fetchImpl.mock.calls[0]?.[0] as string;
    expect(url).toContain('symbol=ETHUSDT');
  });

  it('treats USDT as par with USD without a network call', async () => {
    const fetchImpl = vi.fn();
    const provider = new BinanceProvider({ fetchImpl });
    const rate = await provider.getRate('USDT', 'USD');
    expect(rate.toDecimalString()).toBe('1.000000000000000000');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects a non-USD quote for a stablecoin', async () => {
    const fetchImpl = vi.fn();
    const provider = new BinanceProvider({ fetchImpl });
    await expect(provider.getRate('USDT', 'EUR')).rejects.toThrow(ExchangeRateProviderError);
  });

  it('rejects an unmapped asset', async () => {
    const fetchImpl = vi.fn();
    const provider = new BinanceProvider({ fetchImpl });
    await expect(provider.getRate('DOGE', 'USD')).rejects.toThrow(ExchangeRateProviderError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('treats USDC as par with USD without a network call, same as USDT', async () => {
    const fetchImpl = vi.fn();
    const provider = new BinanceProvider({ fetchImpl });
    const rate = await provider.getRate('USDC', 'USD');
    expect(rate.toDecimalString()).toBe('1.000000000000000000');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects a non-USD quote for USDC', async () => {
    const fetchImpl = vi.fn();
    const provider = new BinanceProvider({ fetchImpl });
    await expect(provider.getRate('USDC', 'EUR')).rejects.toThrow(ExchangeRateProviderError);
  });

  it.each([
    ['missing price field', { symbol: 'ETHUSDT' }],
    ['non-numeric price', { symbol: 'ETHUSDT', price: 'not-a-number' }],
    ['zero price', { symbol: 'ETHUSDT', price: '0' }],
    ['negative price', { symbol: 'ETHUSDT', price: '-100' }],
  ])('throws a retryable error on %s', async (_label, body) => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(body));
    const provider = new BinanceProvider({ fetchImpl });
    await expect(provider.getRate('ETH', 'USD')).rejects.toMatchObject({ retryable: true });
  });
});
