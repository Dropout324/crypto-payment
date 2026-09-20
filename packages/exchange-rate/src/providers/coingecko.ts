import { ExchangeRate } from '@gateway/shared';
import { type ExchangeRateProvider, ExchangeRateProviderError, type FetchLike, fetchWithTimeout } from '../provider.js';

/**
 * CoinGecko's free `/simple/price` endpoint. No API key required at low
 * volume - this is the default provider (see ADR 0005) and is expected to be
 * replaced or paired with a paid tier before production traffic.
 */

const COINGECKO_IDS: Readonly<Record<string, string>> = {
  BTC: 'bitcoin',
  ETH: 'ethereum',
  USDT: 'tether',
  USDC: 'usd-coin',
  BNB: 'binancecoin',
  POL: 'matic-network',
  MATIC: 'matic-network',
};

const FIAT_VS_CURRENCIES = new Set(['usd', 'eur', 'gbp', 'sgd', 'idr', 'jpy']);

export interface CoinGeckoOptions {
  fetchImpl: FetchLike;
  timeoutMs?: number;
  apiKey?: string;
  baseUrl?: string;
}

export class CoinGeckoProvider implements ExchangeRateProvider {
  readonly name = 'coingecko';

  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;

  constructor(options: CoinGeckoOptions) {
    this.fetchImpl = options.fetchImpl;
    this.timeoutMs = options.timeoutMs ?? 3000;
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl ?? 'https://api.coingecko.com/api/v3';
  }

  async getRate(baseAsset: string, quoteAsset: string): Promise<ExchangeRate> {
    const coinId = COINGECKO_IDS[baseAsset.toUpperCase()];
    if (!coinId) {
      throw new ExchangeRateProviderError(this.name, `no CoinGecko mapping for asset ${baseAsset}`, {
        retryable: false,
      });
    }

    const vsCurrency = quoteAsset.toLowerCase();
    if (!FIAT_VS_CURRENCIES.has(vsCurrency) && !COINGECKO_IDS[quoteAsset.toUpperCase()]) {
      throw new ExchangeRateProviderError(this.name, `no CoinGecko mapping for quote ${quoteAsset}`, {
        retryable: false,
      });
    }

    const url = `${this.baseUrl}/simple/price?ids=${coinId}&vs_currencies=${vsCurrency}${
      this.apiKey ? `&x_cg_demo_api_key=${this.apiKey}` : ''
    }`;

    const body = await fetchWithTimeout(this.fetchImpl, url, this.timeoutMs);
    const price = extractPrice(body, coinId, vsCurrency);

    if (price === null) {
      throw new ExchangeRateProviderError(this.name, `no price returned for ${baseAsset}/${quoteAsset}`, {
        retryable: true,
      });
    }

    return ExchangeRate.fromDecimal({
      base: baseAsset.toUpperCase(),
      quote: quoteAsset.toUpperCase(),
      rate: price,
      provider: this.name,
      observedAt: new Date(),
    });
  }
}

function extractPrice(body: unknown, coinId: string, vsCurrency: string): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const coin = (body as Record<string, unknown>)[coinId];
  if (typeof coin !== 'object' || coin === null) return null;
  const raw = (coin as Record<string, unknown>)[vsCurrency];

  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
    // CoinGecko returns a JSON number; converting via string preserves what
    // the API sent without ever doing float arithmetic on it ourselves.
    return raw.toString();
  }
  return null;
}
