import { ExchangeRate } from '@gateway/shared';
import { type ExchangeRateProvider, ExchangeRateProviderError, type FetchLike, fetchWithTimeout } from '../provider.js';

/**
 * Binance's public ticker endpoint, used as the fallback provider. No API key
 * required for market data.
 *
 * Binance quotes against USDT, not fiat directly. USDT is treated as
 * par-with-USD here (its explicit design goal); a quote asset of anything
 * other than USD/USDT is rejected rather than silently mispriced.
 */

const BINANCE_SYMBOLS: Readonly<Record<string, string>> = {
  BTC: 'BTC',
  ETH: 'ETH',
  BNB: 'BNB',
  POL: 'POL',
  MATIC: 'MATIC',
};

const USD_LIKE = new Set(['USD', 'USDT']);

export interface BinanceOptions {
  fetchImpl: FetchLike;
  timeoutMs?: number;
  baseUrl?: string;
}

export class BinanceProvider implements ExchangeRateProvider {
  readonly name = 'binance';

  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly baseUrl: string;

  constructor(options: BinanceOptions) {
    this.fetchImpl = options.fetchImpl;
    this.timeoutMs = options.timeoutMs ?? 3000;
    this.baseUrl = options.baseUrl ?? 'https://api.binance.com';
  }

  async getRate(baseAsset: string, quoteAsset: string): Promise<ExchangeRate> {
    const base = baseAsset.toUpperCase();
    const quote = quoteAsset.toUpperCase();

    // A stablecoin priced against USD/USDT is definitionally ~1; Binance has
    // no USDTUSDT ticker to ask.
    if (base === 'USDT' || base === 'USDC') {
      if (!USD_LIKE.has(quote)) {
        throw new ExchangeRateProviderError(this.name, `cannot price ${base} against ${quote}`, {
          retryable: false,
        });
      }
      return ExchangeRate.fromDecimal({ base, quote, rate: '1.00', provider: this.name, observedAt: new Date() });
    }

    const symbolBase = BINANCE_SYMBOLS[base];
    if (!symbolBase || !USD_LIKE.has(quote)) {
      throw new ExchangeRateProviderError(this.name, `no Binance mapping for ${base}/${quote}`, {
        retryable: false,
      });
    }

    const symbol = `${symbolBase}USDT`;
    const url = `${this.baseUrl}/api/v3/ticker/price?symbol=${symbol}`;
    const body = await fetchWithTimeout(this.fetchImpl, url, this.timeoutMs);
    const price = extractPrice(body);

    if (price === null) {
      throw new ExchangeRateProviderError(this.name, `no price returned for ${symbol}`, { retryable: true });
    }

    return ExchangeRate.fromDecimal({ base, quote, rate: price, provider: this.name, observedAt: new Date() });
  }
}

function extractPrice(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const raw = (body as Record<string, unknown>).price;
  if (typeof raw !== 'string') return null;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? raw : null;
}
