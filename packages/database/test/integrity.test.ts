import { newId } from '@gateway/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  LedgerAccountKind,
  type PrismaClient,
  createPrismaClient,
  debitIncreases,
  decimalToUnits,
  ledgerAccountCode,
  ledgerAccountType,
  parseLedgerAccountCode,
  unitsToDecimal,
} from '../src/index.js';

/**
 * Integration tests for the guarantees the DATABASE enforces, not the ones the
 * application promises. Every case here is a bug that application code could
 * plausibly contain; the point is that the storage layer rejects it anyway.
 */

let db: PrismaClient;
let merchantId: string;

const NETWORK = 'ETHEREUM' as const;
const ASSET = 'USDT';
const DECIMALS = 6;

/**
 * Chain data is globally unique by design, so fixtures must be unique per run
 * too - otherwise the second execution of this suite collides with the first
 * run's rows and reports failures that are really just leftover state.
 */
const RUN = Date.now().toString(16).padStart(12, '0');
const hashFor = (label: string): string =>
  `0x${(RUN + label).padEnd(64, '0').slice(0, 64).replace(/[^0-9a-f]/g, '1')}`;
const addressFor = (label: string): string =>
  `0x${(RUN + label).padEnd(40, '0').slice(0, 40).replace(/[^0-9a-fA-F]/g, '1')}`;

beforeAll(async () => {
  db = createPrismaClient();
  await db.$connect();

  const userId = newId('user');
  await db.user.create({
    data: {
      id: userId,
      email: `integrity-${Date.now()}@test.local`,
      passwordHash: 'argon2id$placeholder',
      platformRole: 'USER',
    },
  });

  merchantId = newId('merchant');
  await db.merchant.create({
    data: {
      id: merchantId,
      name: 'Integrity Test Merchant',
      slug: `integrity-${Date.now()}`,
      status: 'ACTIVE',
      underpaymentPolicy: 'MANUAL_REVIEW',
      overpaymentPolicy: 'MANUAL_REVIEW',
      members: {
        create: { id: newId('merchantMember'), userId, role: 'OWNER' },
      },
    },
  });
});

afterAll(async () => {
  await db?.$disconnect();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function createAccount(kind: (typeof LedgerAccountKind)[keyof typeof LedgerAccountKind]) {
  const scoped =
    kind === LedgerAccountKind.MERCHANT_PAYABLE || kind === LedgerAccountKind.MERCHANT_HOLDINGS;
  const code = ledgerAccountCode({
    kind,
    network: NETWORK,
    assetSymbol: ASSET,
    ...(scoped ? { merchantId } : {}),
  });

  return db.ledgerAccount.upsert({
    where: { code },
    update: {},
    create: {
      id: newId('ledgerAccount'),
      code,
      name: code,
      type: ledgerAccountType(kind),
      assetSymbol: ASSET,
      assetDecimals: DECIMALS,
      network: NETWORK,
      ...(scoped ? { merchantId } : {}),
    },
  });
}

async function createInvoice(overrides: Partial<{ orderId: string }> = {}) {
  const id = newId('invoice');
  return db.invoice.create({
    data: {
      id,
      merchantId,
      orderId: overrides.orderId ?? `ORDER-${id}`,
      requestedCurrency: 'USD',
      requestedDecimals: 2,
      requestedAmount: unitsToDecimal(10_000n), // 100.00 USD
      paymentAsset: ASSET,
      paymentDecimals: DECIMALS,
      network: NETWORK,
      tokenContract: '0xdac17f958d2ee523a2206206994597c13d831ec7',
      cryptoAmount: unitsToDecimal(100_000_000n), // 100.000000 USDT
      exchangeRate: unitsToDecimal(10n ** 18n),
      exchangeRateProvider: 'test',
      exchangeRateAt: new Date(),
      underpaymentPolicy: 'MANUAL_REVIEW',
      overpaymentPolicy: 'MANUAL_REVIEW',
      underpaymentToleranceBps: 0,
      overpaymentToleranceBps: 0,
      requiredConfirmations: 12,
      status: 'PENDING',
      expiresAt: new Date(Date.now() + 900_000),
    },
  });
}

// ---------------------------------------------------------------------------
// Double-entry ledger
// ---------------------------------------------------------------------------

describe('ledger: balanced postings', () => {
  it('accepts a balanced payment credit', async () => {
    const inflow = await createAccount(LedgerAccountKind.CUSTOMER_INFLOW);
    const payable = await createAccount(LedgerAccountKind.MERCHANT_PAYABLE);
    const txId = newId('ledgerTransaction');

    await db.$transaction(async (tx) => {
      await tx.ledgerTransaction.create({
        data: {
          id: txId,
          type: 'payment.credit',
          idempotencyKey: `credit:${txId}`,
        },
      });
      await tx.ledgerEntry.createMany({
        data: [
          {
            id: newId('ledgerEntry'),
            ledgerTransactionId: txId,
            accountId: inflow.id,
            direction: 'DEBIT',
            amount: unitsToDecimal(100_000_000n),
            assetSymbol: ASSET,
            assetDecimals: DECIMALS,
          },
          {
            id: newId('ledgerEntry'),
            ledgerTransactionId: txId,
            accountId: payable.id,
            direction: 'CREDIT',
            amount: unitsToDecimal(100_000_000n),
            assetSymbol: ASSET,
            assetDecimals: DECIMALS,
          },
        ],
      });
    });

    const entries = await db.ledgerEntry.findMany({ where: { ledgerTransactionId: txId } });
    expect(entries).toHaveLength(2);

    const debits = entries
      .filter((e) => e.direction === 'DEBIT')
      .reduce((sum, e) => sum + decimalToUnits(e.amount), 0n);
    const credits = entries
      .filter((e) => e.direction === 'CREDIT')
      .reduce((sum, e) => sum + decimalToUnits(e.amount), 0n);
    expect(debits).toBe(credits);
  });

  it('rejects an unbalanced posting at commit', async () => {
    const inflow = await createAccount(LedgerAccountKind.CUSTOMER_INFLOW);
    const payable = await createAccount(LedgerAccountKind.MERCHANT_PAYABLE);
    const txId = newId('ledgerTransaction');

    await expect(
      db.$transaction(async (tx) => {
        await tx.ledgerTransaction.create({
          data: { id: txId, type: 'payment.credit', idempotencyKey: `bad:${txId}` },
        });
        await tx.ledgerEntry.createMany({
          data: [
            {
              id: newId('ledgerEntry'),
              ledgerTransactionId: txId,
              accountId: inflow.id,
              direction: 'DEBIT',
              amount: unitsToDecimal(100_000_000n),
              assetSymbol: ASSET,
              assetDecimals: DECIMALS,
            },
            {
              // One unit short - the classic rounding bug.
              id: newId('ledgerEntry'),
              ledgerTransactionId: txId,
              accountId: payable.id,
              direction: 'CREDIT',
              amount: unitsToDecimal(99_999_999n),
              assetSymbol: ASSET,
              assetDecimals: DECIMALS,
            },
          ],
        });
      }),
    ).rejects.toThrow(/unbalanced/i);

    // The whole transaction rolled back; no orphaned half-posting survives.
    expect(await db.ledgerEntry.count({ where: { ledgerTransactionId: txId } })).toBe(0);
  });

  it('rejects a single-legged posting', async () => {
    const inflow = await createAccount(LedgerAccountKind.CUSTOMER_INFLOW);
    const txId = newId('ledgerTransaction');

    await expect(
      db.$transaction(async (tx) => {
        await tx.ledgerTransaction.create({
          data: { id: txId, type: 'payment.credit', idempotencyKey: `single:${txId}` },
        });
        await tx.ledgerEntry.create({
          data: {
            id: newId('ledgerEntry'),
            ledgerTransactionId: txId,
            accountId: inflow.id,
            direction: 'DEBIT',
            amount: unitsToDecimal(1n),
            assetSymbol: ASSET,
            assetDecimals: DECIMALS,
          },
        });
      }),
    ).rejects.toThrow(/at least one debit and one credit|entries/i);
  });

  it('rejects an entry whose asset differs from its account', async () => {
    const payable = await createAccount(LedgerAccountKind.MERCHANT_PAYABLE);
    const txId = newId('ledgerTransaction');

    await expect(
      db.$transaction(async (tx) => {
        await tx.ledgerTransaction.create({
          data: { id: txId, type: 'payment.credit', idempotencyKey: `asset:${txId}` },
        });
        await tx.ledgerEntry.create({
          data: {
            id: newId('ledgerEntry'),
            ledgerTransactionId: txId,
            accountId: payable.id,
            direction: 'CREDIT',
            amount: unitsToDecimal(1n),
            assetSymbol: 'ETH', // account holds USDT
            assetDecimals: 18,
          },
        });
      }),
    ).rejects.toThrow(/does not match account/i);
  });

  it('rejects a zero or negative entry amount', async () => {
    const inflow = await createAccount(LedgerAccountKind.CUSTOMER_INFLOW);
    const txId = newId('ledgerTransaction');

    await expect(
      db.$transaction(async (tx) => {
        await tx.ledgerTransaction.create({
          data: { id: txId, type: 'payment.credit', idempotencyKey: `neg:${txId}` },
        });
        await tx.ledgerEntry.create({
          data: {
            id: newId('ledgerEntry'),
            ledgerTransactionId: txId,
            accountId: inflow.id,
            direction: 'DEBIT',
            amount: unitsToDecimal(-1n),
            assetSymbol: ASSET,
            assetDecimals: DECIMALS,
          },
        });
      }),
    ).rejects.toThrow();
  });

  it('refuses to post the same business event twice', async () => {
    const key = `credit:ETHEREUM:0xdup:${Date.now()}`;
    const first = newId('ledgerTransaction');
    const second = newId('ledgerTransaction');
    const inflow = await createAccount(LedgerAccountKind.CUSTOMER_INFLOW);
    const payable = await createAccount(LedgerAccountKind.MERCHANT_PAYABLE);

    const post = async (txId: string) =>
      db.$transaction(async (tx) => {
        await tx.ledgerTransaction.create({
          data: { id: txId, type: 'payment.credit', idempotencyKey: key },
        });
        await tx.ledgerEntry.createMany({
          data: [
            {
              id: newId('ledgerEntry'),
              ledgerTransactionId: txId,
              accountId: inflow.id,
              direction: 'DEBIT',
              amount: unitsToDecimal(500n),
              assetSymbol: ASSET,
              assetDecimals: DECIMALS,
            },
            {
              id: newId('ledgerEntry'),
              ledgerTransactionId: txId,
              accountId: payable.id,
              direction: 'CREDIT',
              amount: unitsToDecimal(500n),
              assetSymbol: ASSET,
              assetDecimals: DECIMALS,
            },
          ],
        });
      });

    await post(first);
    await expect(post(second)).rejects.toThrow();
  });
});

describe('ledger: append-only history', () => {
  it('refuses to update a ledger entry', async () => {
    const entry = await db.ledgerEntry.findFirst({ orderBy: { sequence: 'asc' } });
    expect(entry).not.toBeNull();

    await expect(
      db.ledgerEntry.update({
        where: { id: entry!.id },
        data: { amount: unitsToDecimal(1n) },
      }),
    ).rejects.toThrow(/append-only/i);
  });

  it('refuses to delete a ledger entry', async () => {
    const entry = await db.ledgerEntry.findFirst({ orderBy: { sequence: 'asc' } });
    await expect(db.ledgerEntry.delete({ where: { id: entry!.id } })).rejects.toThrow(
      /append-only/i,
    );
  });

  it('refuses to rewrite a ledger transaction', async () => {
    const tx = await db.ledgerTransaction.findFirst();
    await expect(
      db.ledgerTransaction.update({ where: { id: tx!.id }, data: { description: 'edited' } }),
    ).rejects.toThrow(/append-only/i);
  });

  it('refuses to alter an audit log', async () => {
    const id = newId('auditLog');
    await db.auditLog.create({
      data: {
        id,
        actorType: 'system',
        action: 'test.performed',
        resourceType: 'test',
        merchantId,
      },
    });

    await expect(
      db.auditLog.update({ where: { id }, data: { action: 'test.tampered' } }),
    ).rejects.toThrow(/append-only/i);
    await expect(db.auditLog.delete({ where: { id } })).rejects.toThrow(/append-only/i);
  });
});

// ---------------------------------------------------------------------------
// Invoices
// ---------------------------------------------------------------------------

describe('invoices', () => {
  it('stores and reads back exact smallest units', async () => {
    const invoice = await createInvoice();
    const loaded = await db.invoice.findUniqueOrThrow({ where: { id: invoice.id } });

    expect(decimalToUnits(loaded.cryptoAmount)).toBe(100_000_000n);
    expect(decimalToUnits(loaded.requestedAmount)).toBe(10_000n);
    expect(decimalToUnits(loaded.exchangeRate)).toBe(10n ** 18n);
  });

  it('rejects a duplicate order id for the same merchant', async () => {
    const orderId = `ORDER-DUP-${Date.now()}`;
    await createInvoice({ orderId });
    await expect(createInvoice({ orderId })).rejects.toThrow();
  });

  it('refuses to change the priced terms after creation', async () => {
    const invoice = await createInvoice();

    await expect(
      db.invoice.update({
        where: { id: invoice.id },
        data: { cryptoAmount: unitsToDecimal(1n) },
      }),
    ).rejects.toThrow(/immutable/i);

    await expect(
      db.invoice.update({
        where: { id: invoice.id },
        data: { exchangeRate: unitsToDecimal(2n * 10n ** 18n) },
      }),
    ).rejects.toThrow(/frozen/i);

    await expect(
      db.invoice.update({ where: { id: invoice.id }, data: { network: 'POLYGON' } }),
    ).rejects.toThrow(/immutable/i);
  });

  it('allows the mutable lifecycle fields to advance', async () => {
    const invoice = await createInvoice();

    const updated = await db.invoice.update({
      where: { id: invoice.id },
      data: {
        status: 'DETECTED',
        receivedAmount: unitsToDecimal(100_000_000n),
        confirmationCount: 3,
        detectedAt: new Date(),
        version: { increment: 1 },
      },
    });

    expect(updated.status).toBe('DETECTED');
    expect(updated.version).toBe(1);
  });

  it('refuses a confirmed amount above the received amount', async () => {
    const invoice = await createInvoice();
    await expect(
      db.invoice.update({
        where: { id: invoice.id },
        data: { receivedAmount: unitsToDecimal(10n), confirmedAmount: unitsToDecimal(20n) },
      }),
    ).rejects.toThrow();
  });

  it('refuses an expiry that precedes creation', async () => {
    await expect(
      db.invoice.create({
        data: {
          id: newId('invoice'),
          merchantId,
          orderId: `ORDER-BADEXP-${Date.now()}`,
          requestedCurrency: 'USD',
          requestedDecimals: 2,
          requestedAmount: unitsToDecimal(10_000n),
          paymentAsset: ASSET,
          paymentDecimals: DECIMALS,
          network: NETWORK,
          cryptoAmount: unitsToDecimal(100_000_000n),
          underpaymentPolicy: 'MANUAL_REVIEW',
          overpaymentPolicy: 'MANUAL_REVIEW',
          underpaymentToleranceBps: 0,
          overpaymentToleranceBps: 0,
          requiredConfirmations: 12,
          expiresAt: new Date(Date.now() - 60_000),
        },
      }),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Blockchain idempotency (SPEC section 14)
// ---------------------------------------------------------------------------

describe('blockchain transaction idempotency', () => {
  const txHash = hashFor('aa');

  it('credits one transfer per (network, hash, index) and never twice', async () => {
    const chainTxId = newId('blockchainTransaction');
    await db.blockchainTransaction.create({
      data: {
        id: chainTxId,
        network: NETWORK,
        txHash,
        status: 'MINED',
        blockNumber: 21_000_000n,
        blockHash: hashFor('bb'),
        confirmations: 1,
      },
    });

    const makeTransfer = (transferIndex: number) =>
      db.tokenTransfer.create({
        data: {
          id: newId('tokenTransfer'),
          transactionId: chainTxId,
          network: NETWORK,
          txHash,
          transferIndex,
          tokenContract: '0xdac17f958d2ee523a2206206994597c13d831ec7',
          assetSymbol: ASSET,
          assetDecimals: DECIMALS,
          amount: unitsToDecimal(100_000_000n),
          toAddress: addressFor('ab'),
          toAddressNormalized: addressFor('ab').toLowerCase(),
          matchStatus: 'PENDING_CONFIRMATION',
        },
      });

    await makeTransfer(0);
    // A replayed WebSocket event, a re-scanned block, a restarted worker.
    await expect(makeTransfer(0)).rejects.toThrow();

    // A different log index in the same transaction is a genuinely different
    // transfer and must be allowed.
    await expect(makeTransfer(1)).resolves.toBeTruthy();
  });

  it('allows the same hash on a different network', async () => {
    const otherId = newId('blockchainTransaction');
    await expect(
      db.blockchainTransaction.create({
        data: { id: otherId, network: 'POLYGON', txHash, status: 'MINED' },
      }),
    ).resolves.toBeTruthy();
  });

  it('rejects a duplicate (network, hash)', async () => {
    await expect(
      db.blockchainTransaction.create({
        data: { id: newId('blockchainTransaction'), network: NETWORK, txHash, status: 'MINED' },
      }),
    ).rejects.toThrow();
  });

  it('rejects a non-positive transfer amount', async () => {
    const chainTxId = newId('blockchainTransaction');
    await db.blockchainTransaction.create({
      data: { id: chainTxId, network: NETWORK, txHash: hashFor('cc'), status: 'MINED' },
    });

    await expect(
      db.tokenTransfer.create({
        data: {
          id: newId('tokenTransfer'),
          transactionId: chainTxId,
          network: NETWORK,
          txHash: hashFor('cc'),
          transferIndex: 0,
          assetSymbol: ASSET,
          assetDecimals: DECIMALS,
          amount: unitsToDecimal(0n),
          toAddress: addressFor('ac'),
          toAddressNormalized: addressFor('ac').toLowerCase(),
          matchStatus: 'UNMATCHED',
        },
      }),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------

describe('payment addresses', () => {
  it('is unique per (network, normalized address)', async () => {
    const address = addressFor('d1');
    const normalized = address.toLowerCase();

    await db.paymentAddress.create({
      data: {
        id: newId('paymentAddress'),
        merchantId,
        network: NETWORK,
        address,
        addressNormalized: normalized,
        status: 'AVAILABLE',
      },
    });

    await expect(
      db.paymentAddress.create({
        data: {
          id: newId('paymentAddress'),
          merchantId,
          network: NETWORK,
          address,
          addressNormalized: normalized,
          status: 'AVAILABLE',
        },
      }),
    ).rejects.toThrow();
  });

  it('binds an address to at most one invoice', async () => {
    const invoice = await createInvoice();
    const first = await db.paymentAddress.create({
      data: {
        id: newId('paymentAddress'),
        merchantId,
        network: NETWORK,
        address: addressFor('d2'),
        addressNormalized: addressFor('d2').toLowerCase(),
        status: 'ASSIGNED',
        invoiceId: invoice.id,
        assignedAt: new Date(),
      },
    });
    expect(first.invoiceId).toBe(invoice.id);

    await expect(
      db.paymentAddress.create({
        data: {
          id: newId('paymentAddress'),
          merchantId,
          network: NETWORK,
          address: addressFor('d3'),
          addressNormalized: addressFor('d3').toLowerCase(),
          status: 'ASSIGNED',
          invoiceId: invoice.id,
        },
      }),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Chart of accounts
// ---------------------------------------------------------------------------

describe('chart of accounts', () => {
  it('builds and parses deterministic codes', () => {
    const code = ledgerAccountCode({
      kind: LedgerAccountKind.MERCHANT_PAYABLE,
      network: 'ETHEREUM',
      assetSymbol: 'USDT',
      merchantId: 'mch_123',
    });
    expect(code).toBe('merchant_payable:mch_123:ETHEREUM:USDT');
    expect(parseLedgerAccountCode(code)).toEqual({
      kind: 'merchant_payable',
      merchantId: 'mch_123',
      network: 'ETHEREUM',
      assetSymbol: 'USDT',
    });
  });

  it('requires a merchant for merchant-scoped accounts', () => {
    expect(() =>
      ledgerAccountCode({
        kind: LedgerAccountKind.MERCHANT_PAYABLE,
        network: 'ETHEREUM',
        assetSymbol: 'USDT',
      }),
    ).toThrow(/requires a merchantId/);
  });

  it('rejects a merchant on platform-wide accounts', () => {
    expect(() =>
      ledgerAccountCode({
        kind: LedgerAccountKind.FEE_REVENUE,
        network: 'ETHEREUM',
        assetSymbol: 'USDT',
        merchantId: 'mch_123',
      }),
    ).toThrow(/platform-wide/);
  });

  it('maps normal balance sides correctly', () => {
    expect(debitIncreases('ASSET')).toBe(true);
    expect(debitIncreases('EXPENSE')).toBe(true);
    expect(debitIncreases('LIABILITY')).toBe(false);
    expect(debitIncreases('REVENUE')).toBe(false);
    expect(debitIncreases('EQUITY')).toBe(false);
  });
});
