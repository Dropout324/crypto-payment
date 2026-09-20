import { type IncomingMessage, type ServerResponse, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Logger } from 'pino';
import type { Registry } from 'prom-client';

/**
 * A small `node:http` listener for operational endpoints, on a port separate
 * from any public traffic (ADR 0019):
 *
 * - `/metrics` - Prometheus exposition, when a registry is given.
 * - `/health`  - liveness: answers as long as the process's event loop does.
 *                Touches no dependency, so a slow database can never make an
 *                orchestrator kill a process that restarting would not fix.
 * - `/ready`   - readiness: runs every dependency check (bounded by a
 *                timeout) and answers 503 if any fails, or once shutdown has
 *                begun.
 *
 * `apps/worker` and `apps/blockchain-monitor` serve all three here, since
 * they have no other HTTP server. `apps/api` and `apps/web` already expose
 * probes on their public port and use this for `/metrics` only.
 */

export interface ReadinessCheck {
  name: string;
  check: () => Promise<unknown>;
}

export interface OpsServerOptions {
  port: number;
  host?: string;
  logger: Logger;
  registry?: Registry;
  /** Serve `/health` and `/ready`. */
  probes?: { readiness: readonly ReadinessCheck[] };
  /** Per-check budget for `/ready`; a check slower than this counts as failed. */
  checkTimeoutMs?: number;
}

export interface OpsServer {
  /** The bound port (useful when `port: 0` was requested). */
  readonly port: number;
  /**
   * From now on `/ready` answers 503 so nothing new is routed here, while
   * `/health` keeps answering 200 - the process is draining, not dead, and
   * must not be killed before it finishes.
   */
  markShuttingDown(): void;
  close(): Promise<void>;
}

const DEFAULT_CHECK_TIMEOUT_MS = 2000;

export async function startOpsServer(options: OpsServerOptions): Promise<OpsServer> {
  const { logger, registry, probes } = options;
  const checkTimeoutMs = options.checkTimeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS;
  let shuttingDown = false;

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = (req.url ?? '/').split('?', 1)[0];

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendJson(res, 405, { status: 'method_not_allowed' });
      return;
    }

    if (path === '/metrics' && registry) {
      const body = await registry.metrics();
      res.writeHead(200, { 'content-type': registry.contentType, 'cache-control': 'no-store' });
      res.end(body);
      return;
    }

    if (path === '/health' && probes) {
      sendJson(res, 200, { status: 'ok', timestamp: new Date().toISOString() });
      return;
    }

    if (path === '/ready' && probes) {
      if (shuttingDown) {
        sendJson(res, 503, { status: 'shutting_down', timestamp: new Date().toISOString() });
        return;
      }
      const results = await Promise.all(probes.readiness.map((check) => runCheck(check, checkTimeoutMs, logger)));
      const ready = results.every((result) => result.ok);
      sendJson(res, ready ? 200 : 503, {
        status: ready ? 'ready' : 'not_ready',
        checks: Object.fromEntries(results.map((result) => [result.name, result.ok ? 'ok' : 'unreachable'])),
        timestamp: new Date().toISOString(),
      });
      return;
    }

    sendJson(res, 404, { status: 'not_found' });
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      logger.error({ err: error, path: req.url }, 'ops endpoint failed');
      if (res.headersSent) res.destroy();
      else sendJson(res, 500, { status: 'error' });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host ?? '0.0.0.0', () => {
      server.off('error', reject);
      resolve();
    });
  });

  const port = (server.address() as AddressInfo).port;
  logger.info({ port, metrics: Boolean(registry), probes: Boolean(probes) }, 'ops server listening');

  return {
    port,
    markShuttingDown() {
      shuttingDown = true;
    },
    close() {
      return new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        // Prometheus and kubelet keep connections alive between scrapes/probes;
        // without this `close()` would wait for them to time out on their own.
        server.closeAllConnections();
      });
    },
  };
}

async function runCheck(check: ReadinessCheck, timeoutMs: number, logger: Logger): Promise<{ name: string; ok: boolean }> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      check.check(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`readiness check "${check.name}" timed out after ${timeoutMs}ms`)), timeoutMs);
        timer.unref();
      }),
    ]);
    return { name: check.name, ok: true };
  } catch (error) {
    logger.warn({ err: error, check: check.name }, 'readiness check failed');
    return { name: check.name, ok: false };
  } finally {
    clearTimeout(timer);
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}
