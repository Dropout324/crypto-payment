import { AppError, ErrorCode, ExchangeRate } from '@gateway/shared';
import { type ExchangeRateProvider, ExchangeRateProviderError } from './provider.js';

/**
 * ExchangeRateService (SPEC section 27).
 *
 * Composes providers in priority order with a fallback, a short-lived cache to
 * avoid hammering upstream on repeated invoice creation, and a maximum-age
 * check so a cached-but-stale price is never used to price an invoice.
 *
 * This service NEVER mutates a rate once returned to a caller that freezes it
 * into an invoice - that immutability lives in the caller (the invoice
 * service) and in the database trigger from ADR 0001's migration.
 */

export class RateUnavailableError extends AppError {
  constructor(base: string, quote: string, attempts: readonly { provider: string; error: string }[]) {
    super(
      ErrorCode.RATE_UNAVAILABLE,
      422,
      `no exchange rate provider could price ${base}/${quote}`,
      { details: { base, quote, attempts } },
    );
  }
}

export class RateStaleError extends AppError {
  constructor(base: string, quote: string, ageMs: number, maxAgeMs: number) {
    super(
      ErrorCode.RATE_STALE,
      422,
      `exchange rate for ${base}/${quote} is ${Math.round(ageMs / 1000)}s old, exceeding the ${Math.round(maxAgeMs / 1000)}s limit`,
      { details: { base, quote, ageMs, maxAgeMs } },
    );
  }
}

export interface ExchangeRateServiceOptions {
  /** Tried in order; the first success wins. */
  providers: readonly ExchangeRateProvider[];
  /** Reject a rate (fresh from a provider or from cache) older than this. */
  maxAgeMs?: number;
  /** How long a successful lookup is served from cache before refetching. */
  cacheTtlMs?: number;
  now?: () => Date;
}

interface CacheEntry {
  rate: ExchangeRate;
  cachedAt: number;
}

export class ExchangeRateService {
  private readonly providers: readonly ExchangeRateProvider[];
  private readonly maxAgeMs: number;
  private readonly cacheTtlMs: number;
  private readonly now: () => Date;
  private readonly cache = new Map<string, CacheEntry>();
  /** Coalesces concurrent requests for the same pair into one upstream call. */
  private readonly inFlight = new Map<string, Promise<ExchangeRate>>();

  constructor(options: ExchangeRateServiceOptions) {
    if (options.providers.length === 0) {
      throw new Error('ExchangeRateService requires at least one provider');
    }
    this.providers = options.providers;
    this.maxAgeMs = options.maxAgeMs ?? 120_000;
    this.cacheTtlMs = options.cacheTtlMs ?? 30_000;
    this.now = options.now ?? (() => new Date());
  }

  async getRate(baseAsset: string, quoteAsset: string): Promise<ExchangeRate> {
    const base = baseAsset.toUpperCase();
    const quote = quoteAsset.toUpperCase();

    // A stablecoin priced against itself, or an asset priced against its own
    // symbol, is definitionally 1:1 - no provider call needed or possible.
    if (base === quote) {
      return ExchangeRate.identity(base);
    }

    const cacheKey = `${base}/${quote}`;
    const cached = this.cache.get(cacheKey);
    if (cached && this.now().getTime() - cached.cachedAt < this.cacheTtlMs) {
      this.assertFresh(cached.rate, base, quote);
      return cached.rate;
    }

    const existing = this.inFlight.get(cacheKey);
    if (existing) return existing;

    const promise = this.fetchFresh(base, quote, cacheKey);
    this.inFlight.set(cacheKey, promise);
    try {
      return await promise;
    } finally {
      this.inFlight.delete(cacheKey);
    }
  }

  private async fetchFresh(base: string, quote: string, cacheKey: string): Promise<ExchangeRate> {
    const attempts: { provider: string; error: string }[] = [];

    for (const provider of this.providers) {
      try {
        const rate = await provider.getRate(base, quote);
        this.assertFresh(rate, base, quote);
        this.cache.set(cacheKey, { rate, cachedAt: this.now().getTime() });
        return rate;
      } catch (error) {
        if (error instanceof RateStaleError) throw error; // not a provider failure - do not fall through
        const message = error instanceof Error ? error.message : String(error);
        attempts.push({ provider: provider.name, error: message });

        // A non-retryable error (unsupported pair) means every provider using
        // the same mapping will fail identically - but a different provider
        // may still support it, so we still try the rest.
        if (error instanceof ExchangeRateProviderError && !error.retryable) continue;
      }
    }

    throw new RateUnavailableError(base, quote, attempts);
  }

  /**
   * Staleness is measured against THIS service's clock, not
   * `ExchangeRate.ageMs` (which reads the real wall clock via `Date.now()`).
   * Using the injected clock keeps the service fully deterministic under a
   * fake `now`, and is equivalent to the real clock in production where `now`
   * defaults to `() => new Date()`.
   */
  private assertFresh(rate: ExchangeRate, base: string, quote: string): void {
    const ageMs = this.now().getTime() - rate.observedAt.getTime();
    if (ageMs > this.maxAgeMs) {
      throw new RateStaleError(base, quote, ageMs, this.maxAgeMs);
    }
  }

  /** Drop all cached rates. Exposed for tests and for an admin "force refresh". */
  clearCache(): void {
    this.cache.clear();
  }
}
