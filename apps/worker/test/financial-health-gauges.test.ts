import { newId } from '@gateway/shared';
import { createPrismaClient, type PrismaClient } from '@gateway/database';
import { createFinancialMetrics, createMetricsRegistry } from '@gateway/observability';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { collectFinancialHealthGauges } from '../src/financial-health-gauges.js';

let db: PrismaClient;
const RUN = Date.now().toString(16);
let counter = 0;
function suffix(): string {
  counter += 1;
  return `${RUN}-${counter}`;
}

async function createMerchant(): Promise<string> {
  const s = suffix();
  const userId = newId('user');
  await db.user.create({ data: { id: userId, email: `financial-health-${s}@test.local`, passwordHash: 'x', platformRole: 'USER' } });
  const merchantId = newId('merchant');
  await db.merchant.create({ data: { id: merchantId, name: `Merchant ${s}`, slug: `merchant-${s}` } });
  await db.merchantMember.create({ data: { id: newId('user'), merchantId, userId, role: 'OWNER' } });
  return merchantId;
}

async function createWebhookEndpoint(merchantId: string) {
  const id = newId('webhookEndpoint');
  await db.webhookEndpoint.create({
    data: { id, merchantId, url: 'https://example.test/hook', secretEncrypted: 'x', secretFingerprint: 'x' },
  });
  return id;
}

async function createWebhookEvent(merchantId: string) {
  const id = newId('webhookEvent');
  await db.webhookEvent.create({
    data: { id, merchantId, type: 'payment.paid', payload: {}, idempotencyKey: `evt:${suffix()}` },
  });
  return id;
}

function metricValue(sample: { values: { labels: Record<string, unknown>; value: number }[] } | undefined, labels: Record<string, string>): number | undefined {
  return sample?.values.find((v) => Object.entries(labels).every(([k, val]) => v.labels[k] === val))?.value;
}

beforeAll(async () => {
  db = createPrismaClient();
  await db.$connect();
});

afterAll(async () => {
  await db.$disconnect();
});

describe('collectFinancialHealthGauges', () => {
  it('reports a webhook delivery backlog, settlement status counts and open reconciliation discrepancies', async () => {
    const merchantId = await createMerchant();
    const endpointId = await createWebhookEndpoint(merchantId);
    const event = await createWebhookEvent(merchantId);

    await db.webhookDelivery.create({
      data: {
        id: newId('webhookDelivery'),
        webhookEventId: event,
        endpointId,
        url: 'https://example.test/hook',
        attempt: 1,
        status: 'PENDING',
        signatureTimestamp: new Date(),
        scheduledAt: new Date(),
      },
    });
    await db.webhookDelivery.create({
      data: {
        id: newId('webhookDelivery'),
        webhookEventId: event,
        endpointId,
        url: 'https://example.test/hook',
        attempt: 2,
        status: 'FAILED',
        signatureTimestamp: new Date(),
        scheduledAt: new Date(),
        nextRetryAt: new Date(Date.now() + 60_000),
      },
    });
    // DELIVERED must never count toward the backlog.
    await db.webhookDelivery.create({
      data: {
        id: newId('webhookDelivery'),
        webhookEventId: event,
        endpointId,
        url: 'https://example.test/hook',
        attempt: 3,
        status: 'DELIVERED',
        signatureTimestamp: new Date(),
        scheduledAt: new Date(),
      },
    });

    await db.settlement.create({
      data: {
        id: newId('settlement'),
        merchantId,
        network: 'ETHEREUM',
        assetSymbol: 'USDT',
        assetDecimals: 6,
        grossAmount: '100000000',
        feeAmount: '1000000',
        networkFee: '0',
        netAmount: '99000000',
        status: 'FAILED',
        failureReason: 'broadcast rejected by the node',
      },
    });

    const run = await db.reconciliationRun.create({
      data: { id: newId('reconciliation'), scope: 'ledger_balance', status: 'DISCREPANCIES_FOUND', periodStart: new Date(), periodEnd: new Date() },
    });
    await db.reconciliationDiscrepancy.create({
      data: {
        id: newId('reconciliation'),
        runId: run.id,
        kind: 'LEDGER_IMBALANCE',
        severity: 'CRITICAL',
        subjectType: 'ledger_account',
        subjectId: newId('ledgerAccount'),
      },
    });

    const registry = createMetricsRegistry(`worker-financial-health-${suffix()}`);
    const metrics = createFinancialMetrics(registry);
    await collectFinancialHealthGauges(db, metrics);

    const backlog = await registry.getSingleMetric('gateway_webhook_backlog')?.get();
    expect(metricValue(backlog, { status: 'PENDING' })).toBeGreaterThanOrEqual(1);
    expect(metricValue(backlog, { status: 'FAILED' })).toBeGreaterThanOrEqual(1);

    const settlements = await registry.getSingleMetric('gateway_settlements_by_status')?.get();
    expect(metricValue(settlements, { status: 'FAILED' })).toBeGreaterThanOrEqual(1);
    expect(metricValue(settlements, { status: 'COMPLETED' })).toBe(0);

    const openDiscrepancies = await registry.getSingleMetric('gateway_reconciliation_open_discrepancies')?.get();
    expect(openDiscrepancies?.values[0]?.value).toBeGreaterThanOrEqual(1);
  });

  it('reports zero everywhere on a clean ledger with no backlog', async () => {
    const registry = createMetricsRegistry(`worker-financial-health-clean-${suffix()}`);
    const metrics = createFinancialMetrics(registry);
    await collectFinancialHealthGauges(db, metrics);

    const settlements = await registry.getSingleMetric('gateway_settlements_by_status')?.get();
    // Every known status is pre-seeded at zero even with nothing in that status.
    expect(metricValue(settlements, { status: 'CANCELLED' })).toBe(0);
  });
});
