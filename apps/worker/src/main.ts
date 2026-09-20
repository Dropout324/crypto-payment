import { setTimeout as delay } from 'node:timers/promises';
import { createPrismaClient, type DatabaseClient } from '@gateway/database';
import { EnvKeyProvider } from '@gateway/security';
import { WebhookDispatcher } from '@gateway/webhooks';
import type { ReconciliationSummary } from '@gateway/ledger';
import {
  createFinancialMetrics,
  createLogger,
  createMetricsRegistry,
  createPollLoopMetrics,
  startDependencyHealthGauge,
  startOpsServer,
  type FinancialMetrics,
  type Logger,
  type OpsServer,
} from '@gateway/observability';
import { loadWorkerConfig, validateProductionConfig } from './config.js';
import { sweepExpiredInvoices } from './expiry-sweep.js';
import { collectFinancialHealthGauges } from './financial-health-gauges.js';
import { runReconciliationSweep } from './reconciliation-sweep.js';

/**
 * Entrypoint for the worker process (Phase 6): webhook delivery and the
 * proactive invoice-expiry sweep. Both run as independent poll loops against
 * the same database connection - neither depends on the other, so either can
 * be scaled or split into its own process later without touching the other.
 */
async function main(): Promise<void> {
  const config = loadWorkerConfig();
  validateProductionConfig(config);
  const logger = createLogger({ service: 'worker' });
  const registry = createMetricsRegistry('worker');
  const loopMetrics = createPollLoopMetrics(registry, { prefix: 'gateway_worker', labelNames: ['loop'] });
  loopMetrics.register({ loop: 'webhooks' });
  loopMetrics.register({ loop: 'expiry' });
  loopMetrics.register({ loop: 'reconciliation' });
  loopMetrics.register({ loop: 'financial_health' });
  const financialMetrics = createFinancialMetrics(registry);

  const db = createPrismaClient({ databaseUrl: config.databaseUrl });
  await db.$connect();

  const readinessChecks = [{ name: 'database', check: () => db.$queryRaw`SELECT 1` }];
  // This process has no other HTTP server, so `/health`, `/ready` (database
  // reachability - the only dependency either loop has) and `/metrics` all
  // live on one ops port, never a publicly routed one (ADR 0019).
  const opsServer: OpsServer = await startOpsServer({
    port: config.healthPort,
    logger,
    registry,
    probes: { readiness: readinessChecks },
  });
  // Independent of `/ready` being polled - see `startDependencyHealthGauge`'s
  // doc comment - so "database unavailable" alerts fire even if nothing is
  // hitting the readiness endpoint at the moment it goes down.
  const dependencyHealth = startDependencyHealthGauge(registry, readinessChecks, { logger });

  const keyProvider = new EnvKeyProvider();
  const dispatcher = new WebhookDispatcher(db, {
    keyProvider,
    blockPrivateNetworks: config.webhookBlockPrivateNetworks,
    disableAfterConsecutiveFailures: config.webhookDisableAfterConsecutiveFailures,
    batchSize: config.webhookBatchSize,
  });

  const controller = new AbortController();
  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'received shutdown signal, stopping after the current tick of each loop');
    opsServer.markShuttingDown();
    controller.abort();
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));

  logger.info('connected to the database; starting webhook dispatch, expiry sweep, reconciliation and financial-health loops');

  await Promise.all([
    runWebhookLoop(dispatcher, financialMetrics, config.webhookPollIntervalMs, controller.signal, logger, loopMetrics),
    runExpirySweepLoop(db, config.expirySweepBatchSize, config.expirySweepIntervalMs, controller.signal, logger, loopMetrics),
    runReconciliationLoop(db, financialMetrics, config.reconciliationIntervalMs, controller.signal, logger, loopMetrics),
    runFinancialHealthLoop(db, financialMetrics, config.financialHealthIntervalMs, controller.signal, logger, loopMetrics),
  ]);

  dependencyHealth.stop();
  await opsServer.close();
  await db.$disconnect();
  logger.info('shutdown complete');
}

type LoopMetrics = ReturnType<typeof createPollLoopMetrics<'loop'>>;

async function runWebhookLoop(
  dispatcher: WebhookDispatcher,
  financialMetrics: FinancialMetrics,
  intervalMs: number,
  signal: AbortSignal,
  logger: Logger,
  metrics: LoopMetrics,
): Promise<void> {
  while (!signal.aborted) {
    try {
      const summary = await metrics.track({ loop: 'webhooks' }, async () => {
        const result = await dispatcher.runOnce();
        if (result.failed > 0) financialMetrics.webhookDeliveryFailures.inc({ outcome: 'failed' }, result.failed);
        if (result.exhausted > 0) financialMetrics.webhookDeliveryFailures.inc({ outcome: 'exhausted' }, result.exhausted);
        return result.delivered + result.failed + result.exhausted;
      });
      if (summary > 0) logger.info({ loop: 'webhooks' }, 'tick processed deliveries');
    } catch (error) {
      // A single bad tick (e.g. a transient database blip) must not kill the
      // process - the next tick tries again.
      logger.error({ err: error, loop: 'webhooks' }, 'tick failed');
    }
    await sleep(intervalMs, signal);
  }
}

async function runExpirySweepLoop(
  db: DatabaseClient,
  batchSize: number,
  intervalMs: number,
  signal: AbortSignal,
  logger: Logger,
  metrics: LoopMetrics,
): Promise<void> {
  while (!signal.aborted) {
    try {
      const expired = await metrics.track({ loop: 'expiry' }, async () => {
        const result = await sweepExpiredInvoices(db, batchSize);
        return result.expired;
      });
      if (expired > 0) logger.info({ loop: 'expiry', expired }, 'tick expired invoices');
    } catch (error) {
      logger.error({ err: error, loop: 'expiry' }, 'tick failed');
    }
    await sleep(intervalMs, signal);
  }
}

async function runReconciliationLoop(
  db: DatabaseClient,
  financialMetrics: FinancialMetrics,
  intervalMs: number,
  signal: AbortSignal,
  logger: Logger,
  metrics: LoopMetrics,
): Promise<void> {
  while (!signal.aborted) {
    try {
      const checkedCount = await metrics.track({ loop: 'reconciliation' }, async () => {
        const result: ReconciliationSummary = await runReconciliationSweep(db, financialMetrics);
        return result.checkedCount;
      });
      logger.info({ loop: 'reconciliation', checkedCount }, 'reconciliation run completed');
    } catch (error) {
      logger.error({ err: error, loop: 'reconciliation' }, 'tick failed');
    }
    await sleep(intervalMs, signal);
  }
}

async function runFinancialHealthLoop(
  db: DatabaseClient,
  financialMetrics: FinancialMetrics,
  intervalMs: number,
  signal: AbortSignal,
  logger: Logger,
  metrics: LoopMetrics,
): Promise<void> {
  while (!signal.aborted) {
    try {
      await metrics.track({ loop: 'financial_health' }, async () => {
        await collectFinancialHealthGauges(db, financialMetrics);
        return 0;
      });
    } catch (error) {
      logger.error({ err: error, loop: 'financial_health' }, 'tick failed');
    }
    await sleep(intervalMs, signal);
  }
}

async function sleep(ms: number, signal: AbortSignal): Promise<void> {
  try {
    await delay(ms, undefined, { signal });
  } catch {
    // aborted while sleeping - the loop's `while (!signal.aborted)` check exits next iteration
  }
}

main().catch((error: unknown) => {
  // eslint-disable-next-line no-console
  console.error('[worker] failed to start', error);
  process.exit(1);
});
