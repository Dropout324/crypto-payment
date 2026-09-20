import { Counter } from 'prom-client';
import { afterEach, describe, expect, it } from 'vitest';
import { type OpsServer, createLogger, createMetricsRegistry, startOpsServer } from '../src/index.js';

const logger = createLogger({ service: 'ops-server-test', level: 'silent' });
const servers: OpsServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function start(options: Omit<Parameters<typeof startOpsServer>[0], 'port' | 'host' | 'logger'>): Promise<(path: string) => Promise<Response>> {
  const server = await startOpsServer({ port: 0, host: '127.0.0.1', logger, ...options });
  servers.push(server);
  return (path) => fetch(`http://127.0.0.1:${server.port}${path}`);
}

describe('startOpsServer', () => {
  it('serves Prometheus metrics with the exposition content type', async () => {
    const registry = createMetricsRegistry('worker');
    new Counter({ name: 'gateway_test_things_total', help: 'test', registers: [registry] }).inc(3);
    const get = await start({ registry });

    const response = await get('/metrics');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/plain');
    expect(await response.text()).toContain('gateway_test_things_total{service="worker"} 3');
  });

  it('answers /health without running any dependency check', async () => {
    let checks = 0;
    const get = await start({ probes: { readiness: [{ name: 'database', check: async () => { checks += 1; } }] } });

    const response = await get('/health');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'ok' });
    expect(checks).toBe(0);
  });

  it('answers /ready 200 when every check passes and 503 naming the one that failed', async () => {
    let databaseUp = true;
    const get = await start({
      probes: {
        readiness: [
          { name: 'database', check: async () => { if (!databaseUp) throw new Error('connection refused'); } },
          { name: 'redis', check: async () => undefined },
        ],
      },
    });

    const ready = await get('/ready');
    expect(ready.status).toBe(200);
    expect(await ready.json()).toMatchObject({ status: 'ready', checks: { database: 'ok', redis: 'ok' } });

    databaseUp = false;
    const notReady = await get('/ready');
    expect(notReady.status).toBe(503);
    expect(await notReady.json()).toMatchObject({ status: 'not_ready', checks: { database: 'unreachable', redis: 'ok' } });
  });

  it('treats a check that hangs past the timeout as failed rather than hanging the probe', async () => {
    const get = await start({
      checkTimeoutMs: 50,
      probes: { readiness: [{ name: 'database', check: () => new Promise(() => undefined) }] },
    });

    const started = Date.now();
    const response = await get('/ready');
    expect(response.status).toBe(503);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('reports not ready once shutdown begins while liveness stays up', async () => {
    const server = await startOpsServer({ port: 0, host: '127.0.0.1', logger, probes: { readiness: [] } });
    servers.push(server);
    server.markShuttingDown();

    expect((await fetch(`http://127.0.0.1:${server.port}/ready`)).status).toBe(503);
    expect((await fetch(`http://127.0.0.1:${server.port}/health`)).status).toBe(200);
  });

  it('does not expose probes it was not asked to serve, and 404s unknown paths', async () => {
    const get = await start({ registry: createMetricsRegistry('api') });
    expect((await get('/health')).status).toBe(404);
    expect((await get('/ready')).status).toBe(404);
    expect((await get('/v1/payment-invoices')).status).toBe(404);
  });

  it('stops accepting connections once closed', async () => {
    const server = await startOpsServer({ port: 0, host: '127.0.0.1', logger, probes: { readiness: [] } });
    const url = `http://127.0.0.1:${server.port}/health`;
    expect((await fetch(url)).status).toBe(200);

    await server.close();
    await expect(fetch(url)).rejects.toThrow();
  });
});
