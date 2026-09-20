import type { DatabaseClient } from '@gateway/database';
import type { Redis } from 'ioredis';
import { createApp } from './bootstrap.js';
import { loadConfig, validateProductionConfig } from './config/env.js';
import { PRISMA_CLIENT } from './database/prisma.module.js';
import { REDIS_CLIENT } from './common/redis.module.js';
import { FINANCIAL_METRICS_REGISTRY } from './observability/financial-metrics.provider.js';
import {
  Registry,
  createLogger,
  createMetricsRegistry,
  requestContextLogFields,
  startDependencyHealthGauge,
  startOpsServer,
  type OpsServer,
} from '@gateway/observability';

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  validateProductionConfig(config);
  const logger = createLogger({ service: 'api', context: requestContextLogFields });
  const registry = createMetricsRegistry('api');

  const app = await createApp({ observability: { logger, registry } });
  // Deliberately NOT calling `app.enableShutdownHooks()`: despite its name
  // suggesting it only registers the onModuleDestroy machinery, Nest's own
  // implementation (`enableShutdownHooks(signals = [])`) treats an empty or
  // omitted `signals` array as "listen for every `ShutdownSignal`" - there is
  // no argument that makes it attach zero listeners. Calling it here created
  // a second, competing 'SIGTERM' handler: Nest's own cleanup runs
  // `callDestroyHook()` (onModuleDestroy) immediately, in parallel with and
  // faster than this file's own drain-then-close sequence below, then
  // re-raises the same signal via `process.kill(process.pid, signal)` once
  // done - which this file's `process.once('SIGTERM', ...)` listener, having
  // already fired and self-removed on the first delivery, no longer catches.
  // Node's default disposition for that second, unhandled delivery
  // terminates the process outright (observed live: exit 143, no further
  // log line - the "received shutdown signal" line prints, then the process
  // is gone). `app.close()` below already runs every destroy/shutdown hook
  // on its own regardless of whether `enableShutdownHooks()` was ever
  // called - that method exists only to wire OS signals to an automatic
  // `close()`, which is exactly what this file's own handlers do manually.

  let opsServer: OpsServer | undefined;
  let dependencyHealth: { stop(): void } | undefined;
  if (config.metricsEnabled) {
    // `FINANCIAL_METRICS`'s Nest-managed registry (financial-metrics.provider.ts)
    // is a live view merged in here, not copied - `Registry.merge` registers
    // the same underlying metric objects into a new registry, so `/metrics`
    // keeps reflecting whatever `AdminSigningService`'s signing calls (via
    // `signing.provider.ts`) record on it afterwards.
    const financialRegistry = app.get<Registry>(FINANCIAL_METRICS_REGISTRY);
    const combinedRegistry = Registry.merge([registry, financialRegistry]);

    const db = app.get<DatabaseClient>(PRISMA_CLIENT);
    const redis = app.get<Redis>(REDIS_CLIENT);
    dependencyHealth = startDependencyHealthGauge(
      registry,
      [
        { name: 'database', check: () => db.$queryRaw`SELECT 1` },
        { name: 'redis', check: () => redis.ping() },
      ],
      { logger },
    );

    // `/metrics` is deliberately never on the public listener (ADR 0019):
    // this is the only port it is served on, and nothing here exposes that
    // port outside the cluster/compose network - a scraper reaches it
    // directly, an external client cannot.
    opsServer = await startOpsServer({ port: config.metricsPort, host: config.host, logger, registry: combinedRegistry });
  }

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    void (async () => {
      logger.info({ signal }, 'received shutdown signal, draining in-flight requests');
      opsServer?.markShuttingDown();
      dependencyHealth?.stop();

      // Stop accepting new connections and wait for in-flight ones to finish
      // (fastify's own close(): idle keep-alive sockets are dropped
      // immediately, a request already being handled is allowed to
      // complete), bounded by shutdownTimeoutMs so a stuck request cannot
      // block shutdown forever.
      const httpAdapter = app.getHttpAdapter();
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          httpAdapter.close(),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('drain timed out')), config.shutdownTimeoutMs);
          }),
        ]);
      } catch (error) {
        logger.warn({ err: error }, `in-flight requests did not drain within ${config.shutdownTimeoutMs}ms; forcing close`);
      } finally {
        clearTimeout(timer);
      }

      // Only now tear down providers - by this point no in-flight request
      // can still need the database or Redis. `app.close()` runs
      // RedisLifecycle.onModuleDestroy() (redis.quit()) and
      // PrismaLifecycle.onModuleDestroy() (prisma.$disconnect()); it also
      // retries closing the http adapter, which is a harmless no-op since
      // it is already closed.
      try {
        await app.close();
      } catch (error) {
        logger.error({ err: error }, 'error while closing application providers');
      }
      await opsServer?.close();

      logger.info('shutdown complete');
      process.exit(0);
    })();
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));

  await app.listen(config.port, config.host);
  logger.info({ port: config.port, host: config.host }, 'API listening');
}

bootstrap().catch((error: unknown) => {
  // Startup failed before the logger/app might even exist in a usable state
  // - stderr is the only sink guaranteed to work here.
  // eslint-disable-next-line no-console
  console.error('failed to start API', error);
  process.exit(1);
});
