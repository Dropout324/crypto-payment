import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

export { Registry } from 'prom-client';

/**
 * Prometheus metrics shared by every service (ADR 0019).
 *
 * One `Registry` per process, never prom-client's global one: the api test
 * suite boots many Nest apps in one process, and a global registry would
 * throw "metric already registered" on the second.
 */
export function createMetricsRegistry(service: string): Registry {
  const registry = new Registry();
  registry.setDefaultLabels({ service });
  // Standard process_* / nodejs_* names (event-loop lag, heap, GC, fds), so
  // off-the-shelf Node.js dashboards and alerts work unmodified.
  collectDefaultMetrics({ register: registry });
  return registry;
}

/** Route label for a request that matched no route. Raw paths are never used as labels: every distinct 404 URL would become its own time series. */
export const UNMATCHED_ROUTE = '__unmatched__';

export interface HttpRequestSample {
  method: string;
  /** A route *template* (`/v1/payment-invoices/:id`), never a raw path. */
  route: string;
  statusCode: number;
  durationSeconds: number;
}

export interface HttpMetrics {
  observe(sample: HttpRequestSample): void;
  readonly inFlight: Gauge;
}

const HTTP_DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

/**
 * Request rate is `rate(gateway_http_requests_total[5m])`, error rate the
 * same filtered by `status_code=~"5.."`, latency quantiles come from the
 * histogram - so two series families cover rate, duration and status.
 */
export function createHttpMetrics(registry: Registry): HttpMetrics {
  const labelNames = ['method', 'route', 'status_code'] as const;
  const requests = new Counter({
    name: 'gateway_http_requests_total',
    help: 'HTTP requests completed, by method, route template and status code.',
    labelNames,
    registers: [registry],
  });
  const duration = new Histogram({
    name: 'gateway_http_request_duration_seconds',
    help: 'HTTP request duration from arrival to response end, by method, route template and status code.',
    labelNames,
    buckets: HTTP_DURATION_BUCKETS,
    registers: [registry],
  });
  const inFlight = new Gauge({
    name: 'gateway_http_requests_in_flight',
    help: 'HTTP requests currently being handled.',
    registers: [registry],
  });

  return {
    inFlight,
    observe({ method, route, statusCode, durationSeconds }) {
      const labels = { method, route, status_code: String(statusCode) };
      requests.inc(labels);
      duration.observe(labels, durationSeconds);
    },
  };
}

const TICK_DURATION_BUCKETS = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120];
const TICK_ITEM_BUCKETS = [0, 1, 5, 10, 25, 50, 100, 200, 500, 1000];

export interface PollLoopMetrics<L extends string> {
  /** Creates the label set's series at zero, so `rate()` and "no success yet" alerts work before the first tick. */
  register(labels: Record<L, string>): void;
  /**
   * Runs one tick and records it: duration always; on success the item count
   * and the success timestamp; on failure the error counter. Rethrows, so the
   * loop keeps its own error handling.
   */
  track(labels: Record<L, string>, tick: () => Promise<number>): Promise<number>;
}

/**
 * Metrics for a poll loop - the shape of `apps/worker` and
 * `apps/blockchain-monitor`, which have no request traffic to measure. What
 * matters operationally for a loop is whether it is still completing ticks
 * (`last_success_timestamp_seconds` - alert on `time() - x`), how long a tick
 * takes relative to its interval, how much work each tick finds (a
 * `tick_items` distribution pinned at the batch size means a backlog), and
 * how often ticks fail.
 */
export function createPollLoopMetrics<L extends string>(
  registry: Registry,
  options: { prefix: string; labelNames: readonly L[] },
): PollLoopMetrics<L> {
  const { prefix, labelNames } = options;
  const duration = new Histogram<L>({
    name: `${prefix}_tick_duration_seconds`,
    help: 'Wall-clock duration of one poll-loop tick, successful or not.',
    labelNames,
    buckets: TICK_DURATION_BUCKETS,
    registers: [registry],
  });
  const items = new Histogram<L>({
    name: `${prefix}_tick_items`,
    help: 'Items processed by one successful poll-loop tick.',
    labelNames,
    buckets: TICK_ITEM_BUCKETS,
    registers: [registry],
  });
  const lastSuccess = new Gauge<L>({
    name: `${prefix}_last_success_timestamp_seconds`,
    help: 'Unix time at which the last poll-loop tick completed without throwing.',
    labelNames,
    registers: [registry],
  });
  const errors = new Counter<L>({
    name: `${prefix}_tick_errors_total`,
    help: 'Poll-loop ticks that threw.',
    labelNames,
    registers: [registry],
  });

  return {
    register(labels) {
      errors.inc(labels, 0);
    },
    async track(labels, tick) {
      const stopTimer = duration.startTimer(labels);
      try {
        const count = await tick();
        items.observe(labels, count);
        lastSuccess.set(labels, Date.now() / 1000);
        return count;
      } catch (error) {
        errors.inc(labels);
        throw error;
      } finally {
        stopTimer();
      }
    },
  };
}
