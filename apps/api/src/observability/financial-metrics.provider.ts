import type { Provider } from '@nestjs/common';
import { Registry, createFinancialMetrics, type FinancialMetrics } from '@gateway/observability';

export const FINANCIAL_METRICS_REGISTRY = 'FINANCIAL_METRICS_REGISTRY';
export const FINANCIAL_METRICS = 'FINANCIAL_METRICS';

/**
 * `FinancialMetrics` on its OWN registry, deliberately separate from the
 * `Registry` `main.ts` builds for HTTP metrics. `createApp()` is called many
 * times in one process in the e2e suite (see `metrics.ts`'s own doc comment
 * on why `createMetricsRegistry` never uses prom-client's global registry) -
 * a provider `useFactory` runs again for every one of those Nest application
 * instances, so reusing the SAME registry/metric objects across them would
 * throw "already registered" on the second app. A fresh `Registry` per
 * factory call is safe the same way `createMetricsRegistry` already is.
 *
 * `main.ts` fetches this registry after boot (`app.get(FINANCIAL_METRICS_REGISTRY)`)
 * and merges it into the one actually served on `/metrics` via
 * `Registry.merge` - see its own comment for why that merge is a live view,
 * not a snapshot.
 */
export const financialMetricsRegistryProvider: Provider = {
  provide: FINANCIAL_METRICS_REGISTRY,
  useFactory: (): Registry => new Registry(),
};

export const financialMetricsProvider: Provider = {
  provide: FINANCIAL_METRICS,
  useFactory: (registry: Registry): FinancialMetrics => createFinancialMetrics(registry),
  inject: [FINANCIAL_METRICS_REGISTRY],
};
