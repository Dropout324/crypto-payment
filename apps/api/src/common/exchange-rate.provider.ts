import { Provider } from '@nestjs/common';
import { BinanceProvider, CoinGeckoProvider, ExchangeRateService } from '@gateway/exchange-rate';
import { APP_CONFIG, type AppConfig } from '../config/env.js';

export const EXCHANGE_RATE_SERVICE = 'EXCHANGE_RATE_SERVICE';

/** Node 22 ships a global `fetch`; wrapped here only so it can be swapped in tests. */
const globalFetch: typeof fetch = (...args) => fetch(...args);

export const exchangeRateServiceProvider: Provider = {
  provide: EXCHANGE_RATE_SERVICE,
  useFactory: (config: AppConfig): ExchangeRateService => {
    const built = config.exchangeRateProviders
      .map((name) => {
        if (name === 'coingecko') {
          return new CoinGeckoProvider({
            fetchImpl: globalFetch,
            timeoutMs: config.exchangeRateTimeoutMs,
            apiKey: config.coingeckoApiKey,
          });
        }
        if (name === 'binance') {
          return new BinanceProvider({
            fetchImpl: globalFetch,
            timeoutMs: config.exchangeRateTimeoutMs,
            baseUrl: config.binanceApiBase,
          });
        }
        return null;
      })
      .filter((p): p is CoinGeckoProvider | BinanceProvider => p !== null);

    if (built.length === 0) {
      throw new Error(
        `EXCHANGE_RATE_PROVIDERS lists no recognised provider (got: ${config.exchangeRateProviders.join(', ')})`,
      );
    }

    return new ExchangeRateService({
      providers: built,
      maxAgeMs: config.exchangeRateMaxAgeSeconds * 1000,
      cacheTtlMs: config.exchangeRateCacheTtlSeconds * 1000,
    });
  },
  inject: [APP_CONFIG],
};
