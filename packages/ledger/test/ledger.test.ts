import { Money, newId } from '@gateway/shared';
import {
  type PrismaClient,
  createPrismaClient,
  decimalToUnits,
  runInTransaction,
  unitsToDecimal,
} from '@gateway/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { computeAccountBalance, postPaymentCredit, reconcileAccount, runLedgerReconciliation } from '../src/index.js';

let db: PrismaClient;
/** Default merchant for tests that only care about one posting in isolation. */
let merchantId: string;

const NETWORK = 'ETHEREUM' as const;
const ASSET = 'USDT';
const DECIMALS = 6;
const RUN = Date.now().toString(16);
let orderCounter = 0;
function uniqueSuffix(): string {
  orderCounter += 1;
  return `${RUN}-${orderCounter}`;
}
function hashFor(label: string): string {
  return `0x${(RUN + label).padEnd(64, '0').slice(0, 64).replace(/[^0-9a-f]/g, '1')}`;
}

/**
 * Every posting to a given (merchant, network, asset) lands in the SAME
 * ledger account, so a test that asserts an exact account balance needs its
 * OWN merchant - otherwise it is really asserting "the sum of every posting
 * every test in this file has ever made", which breaks the moment another
 * test runs first.
 */
async function createMerchant(feeBps = 100): Promise<string> {
  const suffix = uniqueSuffix();
  const userId = newId('user');
  await db.user.create({
    data: { id: userId, email: `ledger-${suffix}@test.local`, passwordHash: 'x', platformRole: 'USER' },
  });

  const id = newId('merchant');
  await db.merchant.create({
    data: {
      id,
      name: `Ledger Test Merchant ${suffix}`,
      slug: `ledger-${suffix}`,
      status: 'ACTIVE',
      feeBps,
      underpaymentPolicy: 'MANUAL_REVIEW',
      overpaymentPolicy: 'MANUAL_REVIEW',
      members: { create: { id: newId('merchantMember'), userId, role: 'OWNER' } },
    },
  });
  return id;
}

beforeAll(async () => {
  db = createPrismaClient();
  await db.$connect();
  merchantId = await createMerchant();
});

afterAll(async () => {
  await db?.$disconnect();
});

async function makeInvoiceAndTransfer(label: string, amountUnits: bigint, forMerchantId: string = merchantId) {
  const invoiceId = newId('invoice');
  await db.invoice.create({
    data: {
      id: invoiceId,
      merchantId: forMerchantId,
      orderId: `ORDER-${uniqueSuffix()}`,
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
  await db.blockchainTransaction.create({
    data: { id: chainTxId, network: NETWORK, txHash, status: 'CONFIRMED', confirmations: 20 },
  });

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

  return { invoiceId, transferId, txHash };
}

describe('postPaymentCredit', () => {
  it('splits gross into a net payable leg and a fee revenue leg', async () => {
    const { invoiceId, transferId, txHash } = await makeInvoiceAndTransfer('a1', 100_000_000n); // 100 USDT

    const result = await runInTransaction(db, (tx) =>
      postPaymentCredit(tx, {
        merchantId,
        invoiceId,
        tokenTransferId: transferId,
        network: NETWORK,
        assetSymbol: ASSET,
        assetDecimals: DECIMALS,
        grossAmount: Money.fromUnits(100_000_000n, ASSET, DECIMALS),
        feeBps: 100, // 1%
        idempotencyKey: `credit:${NETWORK}:${txHash}:0`,
      }),
    );

    expect(result.alreadyPosted).toBe(false);
    expect(result.feeAmount.units).toBe(1_000_000n); // 1 USDT
    expect(result.netAmount.units).toBe(99_000_000n); // 99 USDT
    expect(result.grossAmount.add(Money.zero(ASSET, DECIMALS)).units).toBe(100_000_000n);

    const entries = await db.ledgerEntry.findMany({ where: { ledgerTransactionId: result.ledgerTransactionId } });
    expect(entries).toHaveLength(3); // holdings debit, payable credit, fee credit

    const debits = entries.filter((e) => e.direction === 'DEBIT').reduce((s, e) => s + decimalToUnits(e.amount), 0n);
    const credits = entries.filter((e) => e.direction === 'CREDIT').reduce((s, e) => s + decimalToUnits(e.amount), 0n);
    expect(debits).toBe(credits);
    expect(debits).toBe(100_000_000n);
  });

  it('omits the fee leg entirely when feeBps is zero, still balanced with two legs', async () => {
    const { invoiceId, transferId, txHash } = await makeInvoiceAndTransfer('a2', 50_000_000n);

    const result = await runInTransaction(db, (tx) =>
      postPaymentCredit(tx, {
        merchantId,
        invoiceId,
        tokenTransferId: transferId,
        network: NETWORK,
        assetSymbol: ASSET,
        assetDecimals: DECIMALS,
        grossAmount: Money.fromUnits(50_000_000n, ASSET, DECIMALS),
        feeBps: 0,
        idempotencyKey: `credit:${NETWORK}:${txHash}:0`,
      }),
    );

    expect(result.feeAmount.isZero).toBe(true);
    expect(result.netAmount.units).toBe(50_000_000n);

    const entries = await db.ledgerEntry.findMany({ where: { ledgerTransactionId: result.ledgerTransactionId } });
    expect(entries).toHaveLength(2);
  });

  it('is idempotent: replaying the same idempotency key posts nothing new', async () => {
    const { invoiceId, transferId, txHash } = await makeInvoiceAndTransfer('a3', 10_000_000n);
    const key = `credit:${NETWORK}:${txHash}:0`;
    const params = {
      merchantId,
      invoiceId,
      tokenTransferId: transferId,
      network: NETWORK,
      assetSymbol: ASSET,
      assetDecimals: DECIMALS,
      grossAmount: Money.fromUnits(10_000_000n, ASSET, DECIMALS),
      feeBps: 100,
      idempotencyKey: key,
    };

    const first = await runInTransaction(db, (tx) => postPaymentCredit(tx, params));
    const second = await runInTransaction(db, (tx) => postPaymentCredit(tx, params));

    expect(first.alreadyPosted).toBe(false);
    expect(second.alreadyPosted).toBe(true);
    expect(second.ledgerTransactionId).toBe(first.ledgerTransactionId);

    const txCount = await db.ledgerTransaction.count({ where: { idempotencyKey: key } });
    expect(txCount).toBe(1);
  });

  it('rejects a non-positive gross amount', async () => {
    const { invoiceId, transferId, txHash } = await makeInvoiceAndTransfer('a4', 1_000_000n);
    await expect(
      runInTransaction(db, (tx) =>
        postPaymentCredit(tx, {
          merchantId,
          invoiceId,
          tokenTransferId: transferId,
          network: NETWORK,
          assetSymbol: ASSET,
          assetDecimals: DECIMALS,
          grossAmount: Money.zero(ASSET, DECIMALS),
          feeBps: 0,
          idempotencyKey: `credit:${NETWORK}:${txHash}:0`,
        }),
      ),
    ).rejects.toThrow(/gross amount must be positive/);
  });

  it('rounds the fee down, never shorting the merchant on the split', async () => {
    // 1 unit at 3.33% -> exact fee is 0.0333 units; floors to 0, merchant gets all of it.
    const { invoiceId, transferId, txHash } = await makeInvoiceAndTransfer('a5', 1n);
    const result = await runInTransaction(db, (tx) =>
      postPaymentCredit(tx, {
        merchantId,
        invoiceId,
        tokenTransferId: transferId,
        network: NETWORK,
        assetSymbol: ASSET,
        assetDecimals: DECIMALS,
        grossAmount: Money.fromUnits(1n, ASSET, DECIMALS),
        feeBps: 333,
        idempotencyKey: `credit:${NETWORK}:${txHash}:0`,
      }),
    );
    expect(result.feeAmount.isZero).toBe(true);
    expect(result.netAmount.units).toBe(1n);
  });
});

describe('computeAccountBalance', () => {
  it('never trusts a mutable field - it is derived purely from entries', async () => {
    const testMerchantId = await createMerchant();
    const { invoiceId, transferId, txHash } = await makeInvoiceAndTransfer('b1', 20_000_000n, testMerchantId);
    await runInTransaction(db, (tx) =>
      postPaymentCredit(tx, {
        merchantId: testMerchantId,
        invoiceId,
        tokenTransferId: transferId,
        network: NETWORK,
        assetSymbol: ASSET,
        assetDecimals: DECIMALS,
        grossAmount: Money.fromUnits(20_000_000n, ASSET, DECIMALS),
        feeBps: 100,
        idempotencyKey: `credit:${NETWORK}:${txHash}:0`,
      }),
    );

    const payableAccount = await db.ledgerAccount.findFirstOrThrow({
      where: { merchantId: testMerchantId, assetSymbol: ASSET, network: NETWORK, code: { startsWith: 'merchant_payable:' } },
    });

    const balance = await runInTransaction(db, (tx) => computeAccountBalance(tx, payableAccount.id));
    expect(balance.units).toBe(19_800_000n); // 20 USDT - 1% fee
  });
});

describe('reconciliation', () => {
  it('reconciles a freshly-posted account cleanly (no false discrepancy from unrefreshed cache)', async () => {
    const testMerchantId = await createMerchant();
    const { invoiceId, transferId, txHash } = await makeInvoiceAndTransfer('c1', 5_000_000n, testMerchantId);
    await runInTransaction(db, (tx) =>
      postPaymentCredit(tx, {
        merchantId: testMerchantId,
        invoiceId,
        tokenTransferId: transferId,
        network: NETWORK,
        assetSymbol: ASSET,
        assetDecimals: DECIMALS,
        grossAmount: Money.fromUnits(5_000_000n, ASSET, DECIMALS),
        feeBps: 100,
        idempotencyKey: `credit:${NETWORK}:${txHash}:0`,
      }),
    );

    const holdingsAccount = await db.ledgerAccount.findFirstOrThrow({
      where: { merchantId: testMerchantId, assetSymbol: ASSET, network: NETWORK, code: { startsWith: 'merchant_holdings:' } },
    });

    const result = await runInTransaction(db, (tx) => reconcileAccount(tx, holdingsAccount.id));
    expect(result.matched).toBe(true);
    expect(result.computedUnits).toBe(5_000_000n);

    const refreshed = await db.ledgerAccount.findUniqueOrThrow({ where: { id: holdingsAccount.id } });
    expect(decimalToUnits(refreshed.cachedBalance)).toBe(5_000_000n);
  });

  it('detects a genuine cache/ground-truth mismatch and does not silently correct it', async () => {
    const testMerchantId = await createMerchant();
    const { invoiceId, transferId, txHash } = await makeInvoiceAndTransfer('c2', 8_000_000n, testMerchantId);
    await runInTransaction(db, (tx) =>
      postPaymentCredit(tx, {
        merchantId: testMerchantId,
        invoiceId,
        tokenTransferId: transferId,
        network: NETWORK,
        assetSymbol: ASSET,
        assetDecimals: DECIMALS,
        grossAmount: Money.fromUnits(8_000_000n, ASSET, DECIMALS),
        feeBps: 100,
        idempotencyKey: `credit:${NETWORK}:${txHash}:0`,
      }),
    );

    const holdingsAccount = await db.ledgerAccount.findFirstOrThrow({
      where: { merchantId: testMerchantId, assetSymbol: ASSET, network: NETWORK, code: { startsWith: 'merchant_holdings:' } },
    });

    // First pass primes the cache correctly.
    await runInTransaction(db, (tx) => reconcileAccount(tx, holdingsAccount.id));

    // Simulate corruption: something wrote a wrong cached_balance while
    // leaving cached_through_seq at the latest entry, so the delta-based
    // refresh cannot simply "catch up" past it.
    await db.ledgerAccount.update({
      where: { id: holdingsAccount.id },
      data: { cachedBalance: unitsToDecimal(999_999n) },
    });

    const result = await runInTransaction(db, (tx) => reconcileAccount(tx, holdingsAccount.id));
    expect(result.matched).toBe(false);
    expect(result.computedUnits).toBe(8_000_000n);
    expect(result.refreshedUnits).toBe(999_999n);

    // The corrupted value must still be sitting there, untouched.
    const stillCorrupt = await db.ledgerAccount.findUniqueOrThrow({ where: { id: holdingsAccount.id } });
    expect(decimalToUnits(stillCorrupt.cachedBalance)).toBe(999_999n);
  });

  it('runLedgerReconciliation records a discrepancy for a mismatched account and stays CLEAN otherwise', async () => {
    const testMerchantId = await createMerchant();
    const { invoiceId, transferId, txHash } = await makeInvoiceAndTransfer('c3', 3_000_000n, testMerchantId);
    await runInTransaction(db, (tx) =>
      postPaymentCredit(tx, {
        merchantId: testMerchantId,
        invoiceId,
        tokenTransferId: transferId,
        network: NETWORK,
        assetSymbol: ASSET,
        assetDecimals: DECIMALS,
        grossAmount: Money.fromUnits(3_000_000n, ASSET, DECIMALS),
        feeBps: 100,
        idempotencyKey: `credit:${NETWORK}:${txHash}:0`,
      }),
    );

    const clean = await runLedgerReconciliation(db, { merchantId: testMerchantId });
    expect(clean.status).toBe('CLEAN');
    expect(clean.discrepancyCount).toBe(0);

    const holdingsAccount = await db.ledgerAccount.findFirstOrThrow({
      where: { merchantId: testMerchantId, assetSymbol: ASSET, network: NETWORK, code: { startsWith: 'merchant_holdings:' } },
    });
    await db.ledgerAccount.update({ where: { id: holdingsAccount.id }, data: { cachedBalance: unitsToDecimal(1n) } });

    const dirty = await runLedgerReconciliation(db, { merchantId: testMerchantId });
    expect(dirty.status).toBe('DISCREPANCIES_FOUND');
    expect(dirty.discrepancyCount).toBeGreaterThanOrEqual(1);

    const discrepancies = await db.reconciliationDiscrepancy.findMany({
      where: { runId: dirty.runId, subjectId: holdingsAccount.id },
    });
    expect(discrepancies).toHaveLength(1);
    expect(discrepancies[0]).toMatchObject({ kind: 'LEDGER_IMBALANCE', severity: 'CRITICAL' });
  });
});
