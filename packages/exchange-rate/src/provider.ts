import type { ExchangeRate } from '@gateway/shared';

/**
 * ExchangeRateProvider (SPEC section 27).
 *
 * A provider fetches ONE observation of a rate; it does not cache, does not
 * fall back, and does not decide staleness. Those concerns belong to
 * `ExchangeRateService`, which composes providers - that separation is what
 * lets a provider be tested with nothing but a fake HTTP client.
 */
export interface ExchangeRateProvider {
  readonly name: string;
  getRate(baseAsset: string, quoteAsset: string): Promise<ExchangeRate>;
}

export class ExchangeRateProviderError extends Error {
  readonly provider: string;
  readonly retryable: boolean;

  constructor(provider: string, message: string, options: { retryable?: boolean; cause?: unknown } = {}) {
    super(message);
    this.name = 'ExchangeRateProviderError';
    this.provider = provider;
    this.retryable = options.retryable ?? true;
    this.cause = options.cause;
  }
}

/** Minimal fetch shape, so providers and tests do not depend on a specific HTTP client. */
export type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}>;

export async function fetchWithTimeout(
  fetchImpl: FetchLike,
  url: string,
  timeoutMs: number,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(url, { signal: controller.signal });
    if (!response.ok) {
      throw new ExchangeRateProviderError('unknown', `upstream returned HTTP ${response.status}`, {
        retryable: response.status >= 500 || response.status === 429,
      });
    }
    return await response.json();
  } catch (error) {
    if (error instanceof ExchangeRateProviderError) throw error;
    throw new ExchangeRateProviderError('unknown', 'request failed or timed out', {
      retryable: true,
      cause: error,
    });
  } finally {
    clearTimeout(timer);
  }
}
