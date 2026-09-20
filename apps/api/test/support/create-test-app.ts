import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import cookie from '@fastify/cookie';
import { ExchangeRateService, type ExchangeRateProvider } from '@gateway/exchange-rate';
import { ExchangeRate } from '@gateway/shared';
import { AppModule } from '../../src/app.module.js';
import { AppExceptionFilter } from '../../src/common/http-exception.filter.js';
import { EXCHANGE_RATE_SERVICE } from '../../src/common/exchange-rate.provider.js';
import { APP_CONFIG, type AppConfig, loadConfig } from '../../src/config/env.js';

/**
 * Deterministic fixed-rate exchange service: every pair prices at 1 unit of
 * base per unit of quote unless a specific rate is registered. Keeps invoice
 * tests independent of network access and of live market prices.
 */
export class FixedRateProvider implements ExchangeRateProvider {
  readonly name = 'fixed-test-rate';
  private readonly rates = new Map<string, string>();

  set(base: string, quote: string, rate: string): void {
    this.rates.set(`${base}/${quote}`, rate);
  }

  async getRate(base: string, quote: string): Promise<ExchangeRate> {
    const rate = this.rates.get(`${base}/${quote}`) ?? '1';
    return ExchangeRate.fromDecimal({ base, quote, rate, provider: this.name, observedAt: new Date() });
  }
}

export interface TestApp {
  app: NestFastifyApplication;
  rates: FixedRateProvider;
  close: () => Promise<void>;
}

export interface CreateTestAppOptions {
  /** Overrides `APP_CONFIG` (e.g. a tiny `rateLimitAuthPerMinute` to exercise 429s deterministically). */
  configOverrides?: Partial<AppConfig>;
  /** Needed alongside `configOverrides` when a test also needs `X-Forwarded-For` honoured (e.g. distinct rate-limit identities per test). Defaults to `false`, matching production's default posture. */
  trustProxy?: boolean;
}

/**
 * Boots the real AppModule (same wiring as production - guards, DB access,
 * validation, error mapping) with only the exchange-rate provider swapped for
 * a deterministic fake, since Phase 2 has no seam for the RPC-backed pieces
 * that do not exist yet and the real rate providers hit the network.
 */
export async function createTestApp(options: CreateTestAppOptions = {}): Promise<TestApp> {
  const rates = new FixedRateProvider();
  rates.set('USDT', 'USD', '1.00');
  rates.set('ETH', 'USD', '3000.00');
  rates.set('BTC', 'USD', '65000.00');

  let moduleBuilder = Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(EXCHANGE_RATE_SERVICE)
    .useValue(new ExchangeRateService({ providers: [rates], maxAgeMs: 3_600_000, cacheTtlMs: 0 }));

  if (options.configOverrides) {
    moduleBuilder = moduleBuilder
      .overrideProvider(APP_CONFIG)
      .useValue({ ...loadConfig(), ...options.configOverrides });
  }

  const moduleRef = await moduleBuilder.compile();

  const app = moduleRef.createNestApplication<NestFastifyApplication>(
    // `skipMiddie: true` mirrors bootstrap.ts#createApp() - see its comment
    // for why: nothing here calls `app.use()`, so there is no reason to load
    // `@fastify/middie` (and its own advisory history) at all.
    new FastifyAdapter({ trustProxy: options.trustProxy ?? false, skipMiddie: true }),
  );

  await app.register(cookie as never);

  app.useGlobalFilters(new AppExceptionFilter());
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));

  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  return {
    app,
    rates,
    close: async () => {
      await app.close();
    },
  };
}
