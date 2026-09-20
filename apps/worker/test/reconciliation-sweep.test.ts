import { Money, newId } from '@gateway/shared';
import { createPrismaClient, type PrismaClient, decimalToUnits, runInTransaction, unitsToDecimal } from '@gateway/database';
import { postPaymentCredit } from '@gateway/ledger';
import { createFinancialMetrics, createMetricsRegistry } from '@gateway/observability';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runReconciliationSweep } from '../src/reconciliation-sweep.js';

let db: PrismaClient;
const NETWORK = 'ETHEREUM' as const;
const ASSET = 'USDT';
const DECIMALS = 6;
const RUN = Date.now().toString(16);
let counter = 0;
function suffix(): string {
  counter += 1;
  return `${RUN}-${counter}`;
}
function hashFor(label: string): string {
  return `0x${(RUN + label).padEnd(64, '0').slice(0, 64).replace(/[^0-9a-f]/g, '1')}`;
}

async function createMerchant(): Promise<string> {
  const s = suffix();
  const userId = newId('user');
  await db.user.create({ data: { id: userId, email: `reconciliation-sweep-${s}@test.local`, passwordHash: 'x', platformRole: 'USER' } });
  const merchantId = newId('merchant');
  await db.merchant.create({
    data: {
      id: merchantId,
      name: `Merchant ${s}`,
      slug: `merchant-${s}`,
      status: 'ACTIVE',
      feeBps: 100,
      underpaymentPolicy: 'MANUAL_REVIEW',
      overpaymentPolicy: 'MANUAL_REVIEW',
      members: { create: { id: newId('merchantMember'), userId, role: 'OWNER' } },
    },
  });
  return merchantId;
}

/** Mirrors packages/ledger/test/ledger.test.ts's fixture: a PAID invoice with one CREDITED transfer, ready to post a credit for. */
async function makeCreditedTransfer(merchantId: string, label: string, amountUnits: bigint) {
  const invoiceId = newId('invoice');
  await db.invoice.create({
    data: {
      id: invoiceId,
      merchantId,
      orderId: `ORDER-${suffix()}`,
      requestedCurrency: 'USD',
      requestedDecimals: 2,
      requestedAmount: unitsToDecimal(amountUnits / 10_000n || 1n),
      paymentAsset: ASSET,
      paymentDecimals: DECIMALS,
      network: NETWORK,
      cryptoAmount: unitsToDecimal(amountUnits),
      underpaymentPolicy: 'MANUAL_REVIEW',
      overpaymentPolicy: 'MANUAL_REVIEW',
      underpaymentToleranceBps: 0,
      overpaymentToleranceBps: 0,
      requiredConfirmations: 12,
      status: 'PAID',
      expiresAt: new Date(Date.now() + 900_000),
    },
  });

  const chainTxId = newId('blockchainTransaction');
  const txHash = hashFor(label);
  await db.blockchainTransaction.create({ data: { id: chainTxId, network: NETWORK, txHash, status: 'CONFIRMED', confirmations: 20 } });

  const transferId = newId('tokenTransfer');
  await db.tokenTransfer.create({
    data: {
      id: transferId,
      transactionId: chainTxId,
      network: NETWORK,
      txHash,
      transferIndex: 0,
      assetSymbol: ASSET,
      assetDecimals: DECIMALS,
      amount: unitsToDecimal(amountUnits),
      toAddress: '0xabc',
      toAddressNormalized: '0xabc',
      invoiceId,
      matchStatus: 'CREDITED',
      creditedAt: new Date(),
    },
  });

  await runInTransaction(db, (tx) =>
    postPaymentCredit(tx, {
      merchantId,
      invoiceId,
      tokenTransferId: transferId,
      network: NETWORK,
      assetSymbol: ASSET,
      assetDecimals: DECIMALS,
      grossAmount: Money.fromUnits(amountUnits, ASSET, DECIMALS),
      feeBps: 100,
      idempotencyKey: `credit:${NETWORK}:${txHash}:0`,
    }),
  );

  return { invoiceId, transferId, txHash };
}

beforeAll(async () => {
  db = createPrismaClient();
  await db.$connect();
});

afterAll(async () => {
  await db.$disconnect();
});

describe('runReconciliationSweep', () => {
  // `gateway_test` is one shared database across every suite (ADR 0020), not
  // one per file - and `packages/ledger`'s own tests deliberately leave a
  // corrupted account behind by design (proving discrepancies are never
  // silently fixed). A full-ledger sweep run here can therefore legitimately
  // find discrepancies belonging to OTHER tests' fixtures, so this asserts
  // only that THIS test's own account came back clean, never the sweep's
  // global status.
  it('runs a full-ledger reconciliation that leaves a healthy account matched, with no discrepancy recorded for it', async () => {
    const merchantId = await createMerchant();
    await makeCreditedTransfer(merchantId, 'clean', 4_000_000n);
    const holdingsAccount = await db.ledgerAccount.findFirstOrThrow({
      where: { merchantId, assetSymbol: ASSET, network: NETWORK, code: { startsWith: 'merchant_holdings:' } },
    });

    const registry = createMetricsRegistry('worker-reconciliation-clean');
    const metrics = createFinancialMetrics(registry);

    const summary = await runReconciliationSweep(db, metrics);
    expect(summary.checkedCount).toBeGreaterThanOrEqual(1);

    const ownDiscrepancy = await db.reconciliationDiscrepancy.findFirst({
      where: { runId: summary.runId, subjectId: holdingsAccount.id },
    });
    expect(ownDiscrepancy).toBeNull();
  });

  it('detects a real, deliberately-introduced ledger discrepancy and increments the counter', async () => {
    const merchantId = await createMerchant();
    await makeCreditedTransfer(merchantId, 'dirty', 2_500_000n);

    const holdingsAccount = await db.ledgerAccount.findFirstOrThrow({
      where: { merchantId, assetSymbol: ASSET, network: NETWORK, code: { startsWith: 'merchant_holdings:' } },
    });
    // Corrupt the cache the same way ledger.test.ts does: a wrong cached
    // balance with cached_through_seq left at the latest entry, so the
    // scheduled sweep is the only thing that can ever notice this.
    await db.ledgerAccount.update({ where: { id: holdingsAccount.id }, data: { cachedBalance: unitsToDecimal(1n) } });

    const registry = createMetricsRegistry('worker-reconciliation-dirty');
    const metrics = createFinancialMetrics(registry);

    const summary = await runReconciliationSweep(db, metrics);
    expect(summary.status).toBe('DISCREPANCIES_FOUND');
    expect(summary.discrepancyCount).toBeGreaterThanOrEqual(1);

    const counterValue = await registry.getSingleMetric('gateway_reconciliation_discrepancies_total')?.get();
    const sample = counterValue?.values.find((v) => v.labels.kind === 'LEDGER_IMBALANCE');
    expect(sample?.value).toBeGreaterThanOrEqual(1);

    const discrepancy = await db.reconciliationDiscrepancy.findFirstOrThrow({
      where: { runId: summary.runId, subjectId: holdingsAccount.id },
    });
    expect(discrepancy.kind).toBe('LEDGER_IMBALANCE');
    // Still never auto-corrected - the sweep only reports it.
    const stillCorrupt = await db.ledgerAccount.findUniqueOrThrow({ where: { id: holdingsAccount.id } });
    expect(decimalToUnits(stillCorrupt.cachedBalance)).toBe(1n);
  });
});
