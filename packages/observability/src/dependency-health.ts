import { Gauge, type Registry } from 'prom-client';
import type { Logger } from 'pino';
import type { ReadinessCheck } from './ops-server.js';

/**
 * Runs the same checks `/ready` would run, on its own timer, and exposes the
 * result as `gateway_dependency_up{dependency="..."}`. `/ready` alone cannot
 * back a "database unavailable"/"Redis unavailable" alert: it only updates
 * when something happens to poll it (a readiness probe, at whatever interval
 * the orchestrator chose), so a Prometheus rule reading it would see a metric
 * that goes stale in exactly the outage it needs to detect. This runs
 * independently of who calls `/ready`, on a fixed interval, so the gauge is
 * always fresh for Prometheus's own scrape.
 */
export interface DependencyHealthGauge {
  stop(): void;
}

const DEFAULT_INTERVAL_MS = 10_000;
const DEFAULT_CHECK_TIMEOUT_MS = 2000;

export function startDependencyHealthGauge(
  registry: Registry,
  checks: readonly ReadinessCheck[],
  options: { logger: Logger; intervalMs?: number; checkTimeoutMs?: number },
): DependencyHealthGauge {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const checkTimeoutMs = options.checkTimeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS;

  const gauge = new Gauge({
    name: 'gateway_dependency_up',
    help: '1 if the most recent check of this dependency succeeded, 0 otherwise.',
    labelNames: ['dependency'],
    registers: [registry],
  });

  async function runOnce(): Promise<void> {
    await Promise.all(
      checks.map(async (check) => {
        try {
          await Promise.race([
            check.check(),
            new Promise((_, reject) => {
              const timer = setTimeout(() => reject(new Error(`"${check.name}" timed out after ${checkTimeoutMs}ms`)), checkTimeoutMs);
              timer.unref();
            }),
          ]);
          gauge.set({ dependency: check.name }, 1);
        } catch (error) {
          options.logger.warn({ err: error, dependency: check.name }, 'dependency health check failed');
          gauge.set({ dependency: check.name }, 0);
        }
      }),
    );
  }

  void runOnce();
  const timer = setInterval(() => void runOnce(), intervalMs);
  timer.unref();

  return {
    stop() {
      clearInterval(timer);
    },
  };
}
