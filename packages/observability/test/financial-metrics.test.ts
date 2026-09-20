import { describe, expect, it } from 'vitest';
import { createFinancialMetrics, createMetricsRegistry } from '../src/index.js';

async function valueOf(registry: ReturnType<typeof createMetricsRegistry>, name: string, labels: Record<string, string> = {}) {
  const metric = await registry.getSingleMetric(name)?.get();
  const sample = metric?.values.find((value) =>
    Object.entries(labels).every(([key, expected]) => String(value.labels[key]) === expected),
  );
  return sample?.value;
}

describe('createFinancialMetrics', () => {
  it('gives each call its own registry, so several apps in one process do not collide', () => {
    expect(() => {
      createFinancialMetrics(createMetricsRegistry('a'));
      createFinancialMetrics(createMetricsRegistry('b'));
    }).not.toThrow();
  });

  it('counts webhook delivery failures by outcome', async () => {
    const registry = createMetricsRegistry('worker');
    const metrics = createFinancialMetrics(registry);
    metrics.webhookDeliveryFailures.inc({ outcome: 'failed' }, 3);
    metrics.webhookDeliveryFailures.inc({ outcome: 'exhausted' }, 1);

    expect(await valueOf(registry, 'gateway_webhook_delivery_failures_total', { outcome: 'failed' })).toBe(3);
    expect(await valueOf(registry, 'gateway_webhook_delivery_failures_total', { outcome: 'exhausted' })).toBe(1);
  });

  it('sets the webhook backlog gauge by status', async () => {
    const registry = createMetricsRegistry('worker');
    const metrics = createFinancialMetrics(registry);
    metrics.webhookBacklog.set({ status: 'PENDING' }, 42);

    expect(await valueOf(registry, 'gateway_webhook_backlog', { status: 'PENDING' })).toBe(42);
  });

  it('observes payment detection and confirmation latency', async () => {
    const registry = createMetricsRegistry('monitor');
    const metrics = createFinancialMetrics(registry);
    metrics.paymentDetectionLatencySeconds.observe(12);
    metrics.paymentConfirmationLatencySeconds.observe(340);

    const detection = await registry.getSingleMetric('gateway_payment_detection_latency_seconds')?.get();
    expect(detection?.values.find((v) => v.metricName === 'gateway_payment_detection_latency_seconds_count')?.value).toBe(1);
    const confirmation = await registry.getSingleMetric('gateway_payment_confirmation_latency_seconds')?.get();
    expect(confirmation?.values.find((v) => v.metricName === 'gateway_payment_confirmation_latency_seconds_sum')?.value).toBe(340);
  });

  it('records reconciliation discrepancies by kind and tracks the open gauge', async () => {
    const registry = createMetricsRegistry('worker');
    const metrics = createFinancialMetrics(registry);
    metrics.reconciliationDiscrepancies.inc({ kind: 'LEDGER_IMBALANCE' }, 2);
    metrics.reconciliationOpenDiscrepancies.set(2);

    expect(await valueOf(registry, 'gateway_reconciliation_discrepancies_total', { kind: 'LEDGER_IMBALANCE' })).toBe(2);
    expect(await valueOf(registry, 'gateway_reconciliation_open_discrepancies')).toBe(2);
  });

  it('counts RPC failures by network and method', async () => {
    const registry = createMetricsRegistry('monitor');
    const metrics = createFinancialMetrics(registry);
    metrics.rpcFailures.inc({ network: 'ETHEREUM', method: 'getCurrentBlock' });

    expect(await valueOf(registry, 'gateway_monitor_rpc_failures_total', { network: 'ETHEREUM', method: 'getCurrentBlock' })).toBe(1);
  });

  it('counts signing failures by stage', async () => {
    const registry = createMetricsRegistry('api');
    const metrics = createFinancialMetrics(registry);
    metrics.signingFailures.inc({ stage: 'sign_failed' });

    expect(await valueOf(registry, 'gateway_signing_failures_total', { stage: 'sign_failed' })).toBe(1);
  });

  it('counts payments processed', async () => {
    const registry = createMetricsRegistry('monitor');
    const metrics = createFinancialMetrics(registry);
    metrics.paymentsProcessed.inc();
    metrics.paymentsProcessed.inc();

    expect(await valueOf(registry, 'gateway_payments_processed_total')).toBe(2);
  });
});
