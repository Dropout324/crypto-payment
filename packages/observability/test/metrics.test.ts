import { describe, expect, it } from 'vitest';
import { createHttpMetrics, createMetricsRegistry, createPollLoopMetrics } from '../src/index.js';

async function valueOf(registry: ReturnType<typeof createMetricsRegistry>, name: string, labels: Record<string, string> = {}) {
  const metric = await registry.getSingleMetric(name)?.get();
  const sample = metric?.values.find((value) =>
    Object.entries(labels).every(([key, expected]) => String(value.labels[key]) === expected),
  );
  return sample?.value;
}

describe('createMetricsRegistry', () => {
  it('labels every series with the service and includes default process metrics', async () => {
    const registry = createMetricsRegistry('worker');
    const text = await registry.metrics();
    expect(text).toContain('process_cpu_user_seconds_total');
    expect(text).toContain('service="worker"');
  });

  it('gives each call its own registry, so several apps in one process do not collide', () => {
    expect(() => {
      createHttpMetrics(createMetricsRegistry('a'));
      createHttpMetrics(createMetricsRegistry('b'));
    }).not.toThrow();
  });
});

describe('createHttpMetrics', () => {
  it('counts requests and observes duration by method, route template and status', async () => {
    const registry = createMetricsRegistry('api');
    const http = createHttpMetrics(registry);
    http.observe({ method: 'GET', route: '/v1/payment-invoices/:id', statusCode: 200, durationSeconds: 0.02 });
    http.observe({ method: 'GET', route: '/v1/payment-invoices/:id', statusCode: 200, durationSeconds: 0.03 });
    http.observe({ method: 'GET', route: '/v1/payment-invoices/:id', statusCode: 404, durationSeconds: 0.01 });

    expect(await valueOf(registry, 'gateway_http_requests_total', { route: '/v1/payment-invoices/:id', status_code: '200' })).toBe(2);
    expect(await valueOf(registry, 'gateway_http_requests_total', { status_code: '404' })).toBe(1);
    const text = await registry.metrics();
    expect(text).toContain('gateway_http_request_duration_seconds_bucket');
  });
});

describe('createPollLoopMetrics', () => {
  it('records duration, item count and success time for a successful tick', async () => {
    const registry = createMetricsRegistry('worker');
    const loop = createPollLoopMetrics(registry, { prefix: 'gateway_worker', labelNames: ['loop'] });
    loop.register({ loop: 'expiry' });

    const before = Date.now() / 1000;
    await expect(loop.track({ loop: 'expiry' }, async () => 7)).resolves.toBe(7);

    expect(await valueOf(registry, 'gateway_worker_tick_errors_total', { loop: 'expiry' })).toBe(0);
    expect(await valueOf(registry, 'gateway_worker_last_success_timestamp_seconds', { loop: 'expiry' })).toBeGreaterThanOrEqual(before);
    const items = await registry.getSingleMetric('gateway_worker_tick_items')?.get();
    expect(items?.values.find((value) => value.metricName === 'gateway_worker_tick_items_sum')?.value).toBe(7);
    const durations = await registry.getSingleMetric('gateway_worker_tick_duration_seconds')?.get();
    expect(durations?.values.find((value) => value.metricName === 'gateway_worker_tick_duration_seconds_count')?.value).toBe(1);
  });

  it('counts a failed tick, leaves the last-success time alone and rethrows', async () => {
    const registry = createMetricsRegistry('monitor');
    const loop = createPollLoopMetrics(registry, { prefix: 'gateway_monitor', labelNames: ['network'] });
    loop.register({ network: 'ETHEREUM' });

    await expect(loop.track({ network: 'ETHEREUM' }, async () => {
      throw new Error('rpc down');
    })).rejects.toThrow('rpc down');

    expect(await valueOf(registry, 'gateway_monitor_tick_errors_total', { network: 'ETHEREUM' })).toBe(1);
    expect(await valueOf(registry, 'gateway_monitor_last_success_timestamp_seconds', { network: 'ETHEREUM' })).toBeUndefined();
    const durations = await registry.getSingleMetric('gateway_monitor_tick_duration_seconds')?.get();
    expect(durations?.values.find((value) => value.metricName === 'gateway_monitor_tick_duration_seconds_count')?.value).toBe(1);
  });
});
