import { FakeBlockchainAdapter, makeTestBlock } from '@gateway/blockchain';
import { createFinancialMetrics, createMetricsRegistry } from '@gateway/observability';
import { describe, expect, it } from 'vitest';
import { instrumentAdapter } from '../src/instrumented-adapter.js';

function valueOf(registry: ReturnType<typeof createMetricsRegistry>, name: string, labels: Record<string, string>) {
  return registry
    .getSingleMetric(name)
    // prom-client's `.get()` is async in type but synchronous for a Counter with no async collect hook - matches this repo's other tests' `await`.
    .get()
    .then((metric) => metric.values.find((v) => Object.entries(labels).every(([k, val]) => String(v.labels[k]) === val))?.value);
}

describe('instrumentAdapter', () => {
  it('forwards a successful call unchanged and records no failure', async () => {
    const adapter = new FakeBlockchainAdapter('ETHEREUM');
    adapter.addBlock(makeTestBlock({ number: 5n, hash: '0xblock5', parentHash: '0xblock4' }));

    const registry = createMetricsRegistry('monitor-instrumented-ok');
    const metrics = createFinancialMetrics(registry);
    const wrapped = instrumentAdapter(adapter, metrics, 'ETHEREUM');

    const block = await wrapped.getCurrentBlock();
    expect(block.number).toBe(5n);
    expect(await valueOf(registry, 'gateway_monitor_rpc_failures_total', { network: 'ETHEREUM', method: 'getCurrentBlock' })).toBeUndefined();
  });

  it('counts and rethrows a real failure from the underlying adapter', async () => {
    const adapter = new FakeBlockchainAdapter('ETHEREUM'); // no blocks added -> getCurrentBlock throws
    const registry = createMetricsRegistry('monitor-instrumented-fail');
    const metrics = createFinancialMetrics(registry);
    const wrapped = instrumentAdapter(adapter, metrics, 'ETHEREUM');

    await expect(wrapped.getCurrentBlock()).rejects.toThrow('FakeBlockchainAdapter has no blocks yet');
    expect(await valueOf(registry, 'gateway_monitor_rpc_failures_total', { network: 'ETHEREUM', method: 'getCurrentBlock' })).toBe(1);

    // A second, different method's failure is counted under its own label.
    await expect(wrapped.getTransaction('0xdeadbeef')).resolves.toBeNull(); // not found is not a failure
    expect(await valueOf(registry, 'gateway_monitor_rpc_failures_total', { network: 'ETHEREUM', method: 'getTransaction' })).toBeUndefined();
  });

  it('does not add discovery methods when the underlying adapter lacks them (the FakeBlockchainAdapter/Bitcoin case)', () => {
    const adapter = new FakeBlockchainAdapter('ETHEREUM');
    const registry = createMetricsRegistry('monitor-instrumented-no-discovery');
    const metrics = createFinancialMetrics(registry);
    const wrapped = instrumentAdapter(adapter, metrics, 'ETHEREUM') as unknown as Record<string, unknown>;

    expect(typeof wrapped.getLightBlock).not.toBe('function');
    expect(typeof wrapped.getTransferLogsTo).not.toBe('function');
  });

  it('instruments discovery methods when present, preserving the shape scanner.ts feature-detects', async () => {
    const calls: string[] = [];
    const fakeDiscoveryAdapter = {
      network: 'ETHEREUM',
      validateAddress: () => true,
      monitorTransactions: async () => ({ stop: async () => undefined }),
      getBalance: async () => 0n,
      getTransaction: async () => null,
      getTransfers: async () => [],
      getBlock: async () => null,
      getCurrentBlock: async () => ({ number: 1n, hash: '0x1', parentHash: '0x0', timestamp: new Date() }),
      getConfirmations: async () => ({ confirmations: 0, blockNumber: null, chainTip: 1n }),
      getLightBlock: async () => {
        calls.push('getLightBlock');
        return null;
      },
      getTransferLogsTo: async () => {
        throw new Error('rpc provider unreachable');
      },
    };

    const registry = createMetricsRegistry('monitor-instrumented-discovery');
    const metrics = createFinancialMetrics(registry);
    const wrapped = instrumentAdapter(fakeDiscoveryAdapter as never, metrics, 'ETHEREUM') as unknown as {
      getLightBlock: () => Promise<unknown>;
      getTransferLogsTo: () => Promise<unknown>;
    };

    expect(typeof wrapped.getLightBlock).toBe('function');
    await wrapped.getLightBlock();
    expect(calls).toEqual(['getLightBlock']);

    await expect(wrapped.getTransferLogsTo()).rejects.toThrow('rpc provider unreachable');
    expect(await valueOf(registry, 'gateway_monitor_rpc_failures_total', { network: 'ETHEREUM', method: 'getTransferLogsTo' })).toBe(1);
  });
});
