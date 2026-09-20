import { setTimeout as delay } from 'node:timers/promises';
import { Gauge } from 'prom-client';
import { BitcoinRpcAdapter, EvmJsonRpcAdapter } from '@gateway/blockchain';
import { createPrismaClient } from '@gateway/database';
import {
  createFinancialMetrics,
  createLogger,
  createMetricsRegistry,
  createPollLoopMetrics,
  startDependencyHealthGauge,
  startOpsServer,
  type Logger,
  type OpsServer,
} from '@gateway/observability';
import { loadMonitorConfig, validateProductionConfig } from './config.js';
import { instrumentAdapter } from './instrumented-adapter.js';
import { MonitorService } from './monitor.service.js';
import { ChainScanner } from './scanner.js';

/**
 * Entrypoint for the standalone monitor process.
 *
 * `MonitorService` is the same class proven against `FakeBlockchainAdapter`
 * in `test/monitor.e2e.test.ts` (ADR 0004, ADR 0007) - nothing about it
 * changes here. What this file adds is the two pieces ADR 0004 flagged as
 * pending: `EvmJsonRpcAdapter` (`@gateway/blockchain`) as a concrete,
 * RPC-backed `BlockchainAdapter`, and `ChainScanner` to discover which
 * transactions are worth handing to `MonitorService` in the first place -
 * see `scanner.ts` for why that discovery step exists and its documented
 * simplifications.
 *
 * Bitcoin uses a different adapter (`BitcoinRpcAdapter`, UTXO-based rather
 * than account-based - ADR 0027) but the same generic `ChainScanner`/
 * `MonitorService`: both depend only on `BlockchainAdapter`.
 *
 * A network with no RPC URL configured is simply absent from
 * `config.evmNetworks`/`config.bitcoinNetworks` - this process still starts
 * and confirms it can reach the database even if that leaves nothing to
 * watch.
 */
async function main(): Promise<void> {
  const config = loadMonitorConfig();
  validateProductionConfig(config);
  const logger = createLogger({ service: 'monitor' });
  const registry = createMetricsRegistry('monitor');
  const loopMetrics = createPollLoopMetrics(registry, { prefix: 'gateway_monitor', labelNames: ['network'] });
  // Blocks this network's cursor sits behind the chain tip it last observed -
  // the operational number for "is this monitor keeping up", independent of
  // whether any given tick found a candidate transaction.
  const lagGauge = new Gauge({
    name: 'gateway_monitor_scan_lag_blocks',
    help: 'chain_tip - last_processed_block for this network, as of the most recent tick.',
    labelNames: ['network'],
    registers: [registry],
  });

  const financialMetrics = createFinancialMetrics(registry);

  const db = createPrismaClient({ databaseUrl: config.databaseUrl });
  await db.$connect();

  const readinessChecks = [{ name: 'database', check: () => db.$queryRaw`SELECT 1` }];
  const opsServer: OpsServer = await startOpsServer({
    port: config.healthPort,
    logger,
    registry,
    probes: { readiness: readinessChecks },
  });
  const dependencyHealth = startDependencyHealthGauge(registry, readinessChecks, { logger });

  const monitor = new MonitorService(db, undefined, financialMetrics);

  if (config.evmNetworks.length === 0 && config.bitcoinNetworks.length === 0) {
    logger.info('connected to the database; no RPC provider is configured for any network (see .env.example) - idling.');
    await waitForShutdown(opsServer);
    dependencyHealth.stop();
    await opsServer.close();
    await db.$disconnect();
    return;
  }

  const controller = new AbortController();
  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'received shutdown signal, stopping after the current tick of each network');
    opsServer.markShuttingDown();
    controller.abort();
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));

  const evmLoops = config.evmNetworks.map((entry) => {
    loopMetrics.register({ network: entry.network });
    const adapter = instrumentAdapter(
      new EvmJsonRpcAdapter(entry.network, { url: entry.url, fallbackUrl: entry.fallbackUrl }),
      financialMetrics,
      entry.network,
    );
    const scanner = new ChainScanner(db, adapter, monitor, entry.network, config.blockBatchSize);
    logger.info({ network: entry.network }, 'watching network via RPC');
    return runScanLoop(entry.network, scanner, config.pollIntervalMs, controller.signal, logger, loopMetrics, lagGauge);
  });

  const bitcoinLoops = config.bitcoinNetworks.map((entry) => {
    loopMetrics.register({ network: entry.network });
    const adapter = instrumentAdapter(
      new BitcoinRpcAdapter(entry.network, { url: entry.url, rpcUser: entry.rpcUser, rpcPassword: entry.rpcPassword }),
      financialMetrics,
      entry.network,
    );
    const scanner = new ChainScanner(db, adapter, monitor, entry.network, config.blockBatchSize);
    logger.info({ network: entry.network }, 'watching network via RPC');
    return runScanLoop(entry.network, scanner, config.pollIntervalMs, controller.signal, logger, loopMetrics, lagGauge);
  });

  await Promise.all([...evmLoops, ...bitcoinLoops]);
  dependencyHealth.stop();
  await opsServer.close();
  await db.$disconnect();
  logger.info('shutdown complete');
}

type LoopMetrics = ReturnType<typeof createPollLoopMetrics<'network'>>;

async function runScanLoop(
  network: string,
  scanner: ChainScanner,
  intervalMs: number,
  signal: AbortSignal,
  logger: Logger,
  metrics: LoopMetrics,
  lagGauge: Gauge,
): Promise<void> {
  while (!signal.aborted) {
    try {
      const result = await metrics.track({ network }, async () => {
        const tick = await scanner.tick();
        lagGauge.set({ network }, Number(tick.chainTip - tick.lastProcessedBlock));
        return tick.candidateTransactions;
      });
      if (result > 0) logger.info({ network }, 'tick found candidate transactions');
    } catch (error) {
      // A single bad tick (RPC hiccup, transient database error) must not kill
      // the whole process - the cursor is persisted, so the next tick resumes
      // from where the last SUCCESSFUL tick left off.
      logger.error({ err: error, network }, 'tick failed');
    }
    try {
      await delay(intervalMs, undefined, { signal });
    } catch {
      break; // aborted while sleeping
    }
  }
}

/** No network configured: nothing to loop on, but the process must still stay alive to serve /health,/ready until told to stop. */
async function waitForShutdown(opsServer: OpsServer): Promise<void> {
  await new Promise<void>((resolve) => {
    const stop = (): void => {
      opsServer.markShuttingDown();
      resolve();
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}

main().catch((error: unknown) => {
  // eslint-disable-next-line no-console
  console.error('[monitor] failed to start', error);
  process.exit(1);
});
