import { FakeBlockchainAdapter, makeTestBlock, makeTestTransaction } from '@gateway/blockchain';
import { type PrismaClient, createPrismaClient } from '@gateway/database';
import { createFinancialMetrics, createMetricsRegistry } from '@gateway/observability';
import { findAsset } from '@gateway/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MonitorService } from '../src/monitor.service.js';
import { createMerchant, createPendingInvoice, uniqueSuffix } from './support/fixtures.js';

let db: PrismaClient;

const NETWORK = 'ETHEREUM' as const;
const USDT = findAsset(NETWORK, 'USDT')!;
const USDT_CONTRACT = USDT.contractAddress!;

beforeAll(async () => {
  db = createPrismaClient();
  await db.$connect();
});

afterAll(async () => {
  await db?.$disconnect();
});

function freshHash(label: string): string {
  return `0x${(uniqueSuffix() + label).padEnd(64, '0').slice(0, 64).replace(/[^0-9a-f]/g, '1')}`;
}
function freshAddress(): string {
  return `0x${uniqueSuffix().padEnd(40, '0').slice(0, 40).replace(/[^0-9a-fA-F]/g, '1')}`;
}

/**
 * Real evidence for Phase 16/C6's payment/confirmation latency metrics and
 * the "abnormal payment processing rate" counter: this drives the SAME
 * detection -> confirmation -> PAID pipeline `monitor.e2e.test.ts` proves
 * correct, with `MonitorService` wired to a real `FinancialMetrics` instance,
 * and asserts the histograms/counter actually observed real values - not
 * that the code merely compiles.
 */
describe('MonitorService financial metrics', () => {
  it('observes detection latency, confirmation latency and a processed payment on a real PAID pipeline run', async () => {
    const registry = createMetricsRegistry(`monitor-latency-${uniqueSuffix()}`);
    const metrics = createFinancialMetrics(registry);
    const monitor = new MonitorService(db, 120, metrics);

    const merchantId = await createMerchant(db, { feeBps: 100 });
    const depositAddress = freshAddress();
    const { invoiceId } = await createPendingInvoice(db, {
      merchantId,
      network: NETWORK,
      asset: 'USDT',
      decimals: 6,
      cryptoAmountUnits: 50_000_000n,
      requiredConfirmations: 2,
      address: depositAddress,
    });

    const adapter = new FakeBlockchainAdapter(NETWORK);
    const txHash = freshHash('latency');
    const senderAddress = freshAddress();
    adapter.addBlock(
      makeTestBlock({
        number: 200n,
        hash: '0xlatblock200',
        parentHash: '0xlatblock199',
        transactions: [makeTestTransaction({ hash: txHash, blockNumber: 200n, blockHash: '0xlatblock200', fromAddress: senderAddress, toAddress: USDT_CONTRACT })],
      }),
    );
    adapter.setTransfers(txHash, [
      { transferIndex: 0, tokenContract: USDT_CONTRACT, fromAddress: senderAddress, toAddress: depositAddress.toLowerCase(), amount: 50_000_000n },
    ]);

    // Detection.
    await monitor.processTransaction(adapter, NETWORK, txHash);
    const detectionHistogram = await registry.getSingleMetric('gateway_payment_detection_latency_seconds')?.get();
    const detectionCount = detectionHistogram?.values.find((v) => v.metricName === 'gateway_payment_detection_latency_seconds_count')?.value;
    expect(detectionCount).toBe(1);

    // Confirm to the required threshold -> PAID, credited.
    for (let i = 1; i <= 2; i += 1) {
      adapter.addBlock(makeTestBlock({ number: 200n + BigInt(i), hash: `0xlatblock${200 + i}`, parentHash: `0xlatblock${199 + i}` }));
    }
    await monitor.updateConfirmations(adapter, NETWORK);

    const invoice = await db.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
    expect(invoice.status).toBe('PAID');

    const confirmationHistogram = await registry.getSingleMetric('gateway_payment_confirmation_latency_seconds')?.get();
    const confirmationCount = confirmationHistogram?.values.find((v) => v.metricName === 'gateway_payment_confirmation_latency_seconds_count')?.value;
    expect(confirmationCount).toBe(1);

    const processed = await registry.getSingleMetric('gateway_payments_processed_total')?.get();
    expect(processed?.values[0]?.value).toBe(1);
  });
});
