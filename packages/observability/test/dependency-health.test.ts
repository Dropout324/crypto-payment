import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLogger, createMetricsRegistry, startDependencyHealthGauge, type DependencyHealthGauge } from '../src/index.js';

const logger = createLogger({ service: 'dependency-health-test', level: 'silent' });
const gauges: DependencyHealthGauge[] = [];

afterEach(() => {
  gauges.splice(0).forEach((gauge) => gauge.stop());
  vi.useRealTimers();
});

async function valueOf(registry: ReturnType<typeof createMetricsRegistry>, name: string, labels: Record<string, string> = {}) {
  const metric = await registry.getSingleMetric(name)?.get();
  const sample = metric?.values.find((value) =>
    Object.entries(labels).every(([key, expected]) => String(value.labels[key]) === expected),
  );
  return sample?.value;
}

describe('startDependencyHealthGauge', () => {
  it('sets 1 for a passing check and 0 for a failing one, on its own timer', async () => {
    const registry = createMetricsRegistry('worker');
    const gauge = startDependencyHealthGauge(
      registry,
      [
        { name: 'database', check: async () => undefined },
        { name: 'redis', check: async () => { throw new Error('connection refused'); } },
      ],
      { logger },
    );
    gauges.push(gauge);

    // The first run fires immediately (fire-and-forget), not on the interval.
    await vi.waitFor(async () => {
      expect(await valueOf(registry, 'gateway_dependency_up', { dependency: 'database' })).toBe(1);
      expect(await valueOf(registry, 'gateway_dependency_up', { dependency: 'redis' })).toBe(0);
    });
  });

  it('treats a check slower than the timeout as failed', async () => {
    const registry = createMetricsRegistry('worker');
    const gauge = startDependencyHealthGauge(
      registry,
      [{ name: 'slow-database', check: () => new Promise((resolve) => setTimeout(resolve, 500)) }],
      { logger, checkTimeoutMs: 20 },
    );
    gauges.push(gauge);

    await vi.waitFor(async () => {
      expect(await valueOf(registry, 'gateway_dependency_up', { dependency: 'slow-database' })).toBe(0);
    });
  });

  it('re-checks on the given interval, reflecting a dependency that recovers', async () => {
    const registry = createMetricsRegistry('worker');
    let healthy = false;
    const gauge = startDependencyHealthGauge(
      registry,
      [{ name: 'database', check: async () => { if (!healthy) throw new Error('down'); } }],
      { logger, intervalMs: 20 },
    );
    gauges.push(gauge);

    await vi.waitFor(async () => {
      expect(await valueOf(registry, 'gateway_dependency_up', { dependency: 'database' })).toBe(0);
    });

    healthy = true;
    await vi.waitFor(async () => {
      expect(await valueOf(registry, 'gateway_dependency_up', { dependency: 'database' })).toBe(1);
    });
  });

  it('stop() halts further checks', async () => {
    const registry = createMetricsRegistry('worker');
    let checks = 0;
    const gauge = startDependencyHealthGauge(
      registry,
      [{ name: 'database', check: async () => { checks += 1; } }],
      { logger, intervalMs: 15 },
    );

    await vi.waitFor(() => expect(checks).toBeGreaterThanOrEqual(1));
    gauge.stop();
    const countAtStop = checks;
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(checks).toBe(countAtStop);
  });
});
