import type { BlockchainAdapter } from '@gateway/blockchain';
import type { FinancialMetrics } from '@gateway/observability';

/**
 * Wraps a `BlockchainAdapter` so every call that throws counts against
 * `gateway_monitor_rpc_failures_total{network, method}` (Phase 16/C6's "RPC
 * provider unavailable" alert) before rethrowing unchanged - nothing about
 * error handling or control flow changes for `ChainScanner`/`MonitorService`.
 *
 * Deliberately NOT a `Proxy`: `validateAddress` is synchronous and pure (no
 * RPC involved), so wrapping every property blindly would turn it into an
 * async function and break any caller that uses its return value directly.
 * Only the network-bound, promise-returning methods are wrapped; everything
 * else (`network`, `validateAddress`, `monitorTransactions` - unused by
 * `ChainScanner`) is forwarded as-is.
 *
 * `getLightBlock`/`getTransferLogsTo` are `EvmJsonRpcAdapter`'s extra
 * cheap-discovery methods, not part of `BlockchainAdapter` itself
 * (`scanner.ts`'s `asEvmDiscoveryAdapter` feature-detects them by shape) -
 * they are copied across, instrumented the same way, only when present, so
 * the fast discovery path keeps working unchanged on a wrapped adapter.
 */
export function instrumentAdapter<T extends BlockchainAdapter>(adapter: T, metrics: FinancialMetrics, network: string): T {
  function wrap<Args extends unknown[], R>(method: string, fn: (...args: Args) => Promise<R>): (...args: Args) => Promise<R> {
    return async (...args: Args) => {
      try {
        return await fn.apply(adapter, args);
      } catch (error) {
        metrics.rpcFailures.inc({ network, method });
        throw error;
      }
    };
  }

  const wrapped: BlockchainAdapter = {
    network: adapter.network,
    validateAddress: adapter.validateAddress,
    monitorTransactions: adapter.monitorTransactions.bind(adapter),
    getBalance: wrap('getBalance', adapter.getBalance.bind(adapter)),
    getTransaction: wrap('getTransaction', adapter.getTransaction.bind(adapter)),
    getTransfers: wrap('getTransfers', adapter.getTransfers.bind(adapter)),
    getBlock: wrap('getBlock', adapter.getBlock.bind(adapter)),
    getCurrentBlock: wrap('getCurrentBlock', adapter.getCurrentBlock.bind(adapter)),
    getConfirmations: wrap('getConfirmations', adapter.getConfirmations.bind(adapter)),
  };

  const discovery = adapter as Partial<{ getLightBlock: (...args: unknown[]) => Promise<unknown>; getTransferLogsTo: (...args: unknown[]) => Promise<unknown> }>;
  const extra: Record<string, unknown> = {};
  if (typeof discovery.getLightBlock === 'function') {
    extra.getLightBlock = wrap('getLightBlock', discovery.getLightBlock.bind(adapter));
  }
  if (typeof discovery.getTransferLogsTo === 'function') {
    extra.getTransferLogsTo = wrap('getTransferLogsTo', discovery.getTransferLogsTo.bind(adapter));
  }

  return Object.assign(wrapped, extra) as T;
}
