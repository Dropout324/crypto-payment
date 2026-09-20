// Production entrypoint used by the `web` Docker target (see
// infrastructure/docker/Dockerfile). Thin wrapper around Next's programmatic
// server, mirroring how apps/api and apps/worker boot from a plain
// `node apps/<x>/dist/main.js` / `main.ts` entry rather than a CLI.
//
// Also where this service's observability lives (ADR 0019): structured
// logging, HTTP metrics and `/metrics` itself. `apps/web` has no NestJS
// request pipeline to hook into, so this hand-rolled `http.Server` wrapper -
// which already exists to host Next's request handler - is the one place
// every request passes through.
const { createServer } = require('node:http');
const next = require('next');
const {
  createLogger,
  createMetricsRegistry,
  createHttpMetrics,
  startOpsServer,
  resolveRequestId,
  runWithRequestContext,
  requestContextLogFields,
  REQUEST_ID_HEADER,
  UNMATCHED_ROUTE,
} = require('@gateway/observability');

const port = Number(process.env.PORT) || 3000;
const metricsEnabled = process.env.METRICS_ENABLED !== 'false';
// A distinct env var from apps/api's METRICS_PORT: a developer running
// `pnpm dev:api` and `pnpm dev:web` from the same loaded .env would otherwise
// have both processes try to bind the same port.
const metricsPort = Number(process.env.WEB_METRICS_PORT) || 9467;
const shutdownTimeoutMs = Number(process.env.SHUTDOWN_TIMEOUT_MS) || 10_000;

const logger = createLogger({ service: 'web', context: requestContextLogFields });
const registry = createMetricsRegistry('web');
const httpMetrics = createHttpMetrics(registry);

// Bounds the cardinality of the route label: a raw `req.url` would give
// every distinct invoice id on the hosted payment page (`/pay/:invoiceId`)
// its own time series, and static-asset paths under `/_next/` are
// content-hashed per build. A custom `http.Server` sees requests before Next
// has matched a route, so - unlike apps/api's fastify hook, which reads the
// framework's own matched route template - this is a hand-maintained list;
// it only needs to track apps/web/src/app's top-level route folders.
const KNOWN_ROUTES = new Set([
  '/',
  '/health',
  '/login',
  '/admin',
  '/admin/compliance',
  '/admin/merchants',
  '/admin/reconciliation',
  '/admin/refunds',
  '/admin/settlements',
  '/dashboard',
  '/dashboard/api-keys',
  '/dashboard/invoices',
  '/dashboard/settings',
  '/dashboard/transactions',
  '/dashboard/webhooks',
]);

function routeTemplate(pathname) {
  if (pathname.startsWith('/_next/')) return '/_next/*';
  if (pathname.startsWith('/pay/')) return '/pay/:invoiceId';
  return KNOWN_ROUTES.has(pathname) ? pathname : UNMATCHED_ROUTE;
}

const app = next({ dev: false, dir: __dirname });
const handle = app.getRequestHandler();

app.prepare().then(async () => {
  const opsServer = metricsEnabled
    ? // `/metrics` is deliberately never on `port` (ADR 0019) - this is the
      // only port it is served on.
      await startOpsServer({ port: metricsPort, logger, registry })
    : undefined;

  const server = createServer((req, res) => {
    const requestId = resolveRequestId(req.headers[REQUEST_ID_HEADER]);
    res.setHeader(REQUEST_ID_HEADER, requestId);

    const startedAt = process.hrtime.bigint();
    httpMetrics.inFlight.inc();
    res.on('finish', () => {
      httpMetrics.inFlight.dec();
      const durationSeconds = Number(process.hrtime.bigint() - startedAt) / 1e9;
      const pathname = (req.url || '/').split('?', 1)[0];
      httpMetrics.observe({ method: req.method || 'GET', route: routeTemplate(pathname), statusCode: res.statusCode, durationSeconds });
    });

    runWithRequestContext({ requestId }, () => handle(req, res));
  });

  server.listen(port, () => {
    logger.info({ port }, 'web listening');
  });

  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'received shutdown signal, draining in-flight requests');
    opsServer?.markShuttingDown();

    const timer = setTimeout(() => {
      logger.warn(`in-flight requests did not drain within ${shutdownTimeoutMs}ms; forcing close`);
      process.exit(1);
    }, shutdownTimeoutMs);
    timer.unref();

    // node:http's close(): stops accepting new connections, waits for
    // in-flight requests on existing ones to finish before the callback runs.
    server.close(async () => {
      clearTimeout(timer);
      await opsServer?.close();
      logger.info('shutdown complete');
      process.exit(0);
    });
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
});
