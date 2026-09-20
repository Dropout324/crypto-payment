import { FakeBlockchainAdapter, makeTestBlock, makeTestTransaction } from '@gateway/blockchain';
import { type PrismaClient, createPrismaClient, decimalToUnits } from '@gateway/database';
import { findAsset, newId } from '@gateway/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MonitorService } from '../src/monitor.service.js';
import { createMerchant, createPendingInvoice, uniqueSuffix } from './support/fixtures.js';

let db: PrismaClient;
let monitor: MonitorService;

const NETWORK = 'ETHEREUM' as const;
const USDT = findAsset(NETWORK, 'USDT')!;
const USDT_CONTRACT = USDT.contractAddress!;

beforeAll(async () => {
  db = createPrismaClient();
  await db.$connect();
  monitor = new MonitorService(db, 120);
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

/** Advances the fake chain by `count` empty blocks past the given tx's block, then runs updateConfirmations. */
async function mineAndConfirm(adapter: FakeBlockchainAdapter, fromBlock: bigint, count: number): Promise<void> {
  for (let i = 1; i <= count; i += 1) {
    adapter.addBlock(makeTestBlock({ number: fromBlock + BigInt(i), hash: `0xblock${fromBlock + BigInt(i)}`, parentHash: `0xblock${fromBlock + BigInt(i) - 1n}` }));
  }
  await monitor.updateConfirmations(adapter, NETWORK);
}

describe('end-to-end: detection through payment and ledger posting', () => {
  it('walks PENDING -> DETECTED -> CONFIRMING -> PAID and posts a balanced ledger credit', async () => {
    const merchantId = await createMerchant(db, { feeBps: 100 });
    const depositAddress = freshAddress();
    const { invoiceId } = await createPendingInvoice(db, {
      merchantId,
      network: NETWORK,
      asset: 'USDT',
      decimals: 6,
      cryptoAmountUnits: 100_000_000n, // 100 USDT
      requiredConfirmations: 3,
      address: depositAddress,
    });

    const adapter = new FakeBlockchainAdapter(NETWORK);
    const txHash = freshHash('paid');
    const senderAddress = freshAddress();

    adapter.addBlock(
      makeTestBlock({
        number: 100n,
        hash: '0xblock100',
        parentHash: '0xblock99',
        transactions: [makeTestTransaction({ hash: txHash, blockNumber: 100n, blockHash: '0xblock100', fromAddress: senderAddress, toAddress: USDT_CONTRACT })],
      }),
    );
    adapter.setTransfers(txHash, [
      { transferIndex: 0, tokenContract: USDT_CONTRACT, fromAddress: senderAddress, toAddress: depositAddress.toLowerCase(), amount: 100_000_000n },
    ]);

    // 1. Detection: the transaction is seen for the first time.
    await monitor.processTransaction(adapter, NETWORK, txHash);

    let invoice = await db.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
    expect(invoice.status).toBe('DETECTED');
    expect(invoice.detectedAt).not.toBeNull();

    const detectedEvent = await db.webhookEvent.findUnique({ where: { idempotencyKey: `payment.detected:${invoiceId}` } });
    expect(detectedEvent).not.toBeNull();

    // 2. One confirmation: CONFIRMING.
    await mineAndConfirm(adapter, 100n, 0); // still at block 100, 1 confirmation
    await monitor.updateConfirmations(adapter, NETWORK);
    invoice = await db.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
    expect(invoice.status).toBe('CONFIRMING');

    // 3. Reaches the required 3 confirmations: PAID.
    await mineAndConfirm(adapter, 100n, 2); // tip now 102 -> 3 confirmations
    invoice = await db.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
    expect(invoice.status).toBe('PAID');
    expect(invoice.paidAt).not.toBeNull();
    expect(decimalToUnits(invoice.receivedAmount)).toBe(100_000_000n);

    const paidEvent = await db.webhookEvent.findUnique({ where: { idempotencyKey: `payment.paid:${invoiceId}` } });
    expect(paidEvent).not.toBeNull();

    // 4. The transfer is marked CREDITED, never eligible to be credited again.
    const transfer = await db.tokenTransfer.findFirstOrThrow({ where: { invoiceId } });
    expect(transfer.matchStatus).toBe('CREDITED');
    expect(transfer.creditedAt).not.toBeNull();

    // 5. The ledger posting balances and matches the expected fee split.
    const ledgerTx = await db.ledgerTransaction.findUniqueOrThrow({
      where: { idempotencyKey: `credit:${NETWORK}:${txHash}:0` },
    });
    const entries = await db.ledgerEntry.findMany({ where: { ledgerTransactionId: ledgerTx.id } });
    expect(entries).toHaveLength(3);
    const debits = entries.filter((e) => e.direction === 'DEBIT').reduce((s, e) => s + decimalToUnits(e.amount), 0n);
    const credits = entries.filter((e) => e.direction === 'CREDIT').reduce((s, e) => s + decimalToUnits(e.amount), 0n);
    expect(debits).toBe(credits);
    expect(debits).toBe(100_000_000n);

    const payableEntry = entries.find((e) => e.direction === 'CREDIT' && decimalToUnits(e.amount) === 99_000_000n);
    const feeEntry = entries.find((e) => e.direction === 'CREDIT' && decimalToUnits(e.amount) === 1_000_000n);
    expect(payableEntry).toBeDefined();
    expect(feeEntry).toBeDefined();
  });

  it('is idempotent: reprocessing the same transaction changes nothing once credited', async () => {
    const merchantId = await createMerchant(db, { feeBps: 0 });
    const depositAddress = freshAddress();
    const { invoiceId } = await createPendingInvoice(db, {
      merchantId,
      network: NETWORK,
      asset: 'USDT',
      decimals: 6,
      cryptoAmountUnits: 10_000_000n,
      requiredConfirmations: 1,
      address: depositAddress,
    });

    const adapter = new FakeBlockchainAdapter(NETWORK);
    const txHash = freshHash('idem');
    adapter.addBlock(
      makeTestBlock({
        number: 200n,
        hash: '0xblockA',
        parentHash: '0xblock199',
        transactions: [makeTestTransaction({ hash: txHash, blockNumber: 200n, blockHash: '0xblockA', toAddress: USDT_CONTRACT })],
      }),
    );
    adapter.setTransfers(txHash, [
      { transferIndex: 0, tokenContract: USDT_CONTRACT, fromAddress: null, toAddress: depositAddress.toLowerCase(), amount: 10_000_000n },
    ]);

    await monitor.processTransaction(adapter, NETWORK, txHash);
    await monitor.updateConfirmations(adapter, NETWORK);

    const paidOnce = await db.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
    expect(paidOnce.status).toBe('PAID');
    const ledgerCountBefore = await db.ledgerTransaction.count({ where: { invoiceId } });

    // Re-scan the exact same transaction and re-run confirmation updates.
    await monitor.processTransaction(adapter, NETWORK, txHash);
    await monitor.updateConfirmations(adapter, NETWORK);

    const paidAgain = await db.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
    expect(paidAgain.status).toBe('PAID');
    expect(paidAgain.paidAt?.getTime()).toBe(paidOnce.paidAt?.getTime());
    const ledgerCountAfter = await db.ledgerTransaction.count({ where: { invoiceId } });
    expect(ledgerCountAfter).toBe(ledgerCountBefore);
  });
});

describe('underpayment and overpayment', () => {
  it('lands on UNDERPAID and does not post a ledger credit under MANUAL_REVIEW', async () => {
    const merchantId = await createMerchant(db, { underpaymentPolicy: 'MANUAL_REVIEW' });
    const depositAddress = freshAddress();
    const { invoiceId } = await createPendingInvoice(db, {
      merchantId,
      network: NETWORK,
      asset: 'USDT',
      decimals: 6,
      cryptoAmountUnits: 100_000_000n,
      requiredConfirmations: 1,
      address: depositAddress,
    });

    const adapter = new FakeBlockchainAdapter(NETWORK);
    const txHash = freshHash('under');
    adapter.addBlock(
      makeTestBlock({
        number: 300n,
        hash: '0xblockU',
        parentHash: '0xblock299',
        transactions: [makeTestTransaction({ hash: txHash, blockNumber: 300n, blockHash: '0xblockU', toAddress: USDT_CONTRACT })],
      }),
    );
    adapter.setTransfers(txHash, [
      { transferIndex: 0, tokenContract: USDT_CONTRACT, fromAddress: null, toAddress: depositAddress.toLowerCase(), amount: 95_000_000n },
    ]);

    await monitor.processTransaction(adapter, NETWORK, txHash);
    await monitor.updateConfirmations(adapter, NETWORK);

    const invoice = await db.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
    expect(invoice.status).toBe('UNDERPAID');
    expect(await db.ledgerTransaction.count({ where: { invoiceId } })).toBe(0);
  });

  it('auto-accepts an underpayment as PAID and credits what was received when the policy is ACCEPT_PARTIAL', async () => {
    const merchantId = await createMerchant(db, { underpaymentPolicy: 'ACCEPT_PARTIAL' });
    const depositAddress = freshAddress();
    const { invoiceId } = await createPendingInvoice(db, {
      merchantId,
      network: NETWORK,
      asset: 'USDT',
      decimals: 6,
      cryptoAmountUnits: 100_000_000n,
      requiredConfirmations: 1,
      address: depositAddress,
    });

    const adapter = new FakeBlockchainAdapter(NETWORK);
    const txHash = freshHash('partial');
    adapter.addBlock(
      makeTestBlock({
        number: 400n,
        hash: '0xblockP',
        parentHash: '0xblock399',
        transactions: [makeTestTransaction({ hash: txHash, blockNumber: 400n, blockHash: '0xblockP', toAddress: USDT_CONTRACT })],
      }),
    );
    adapter.setTransfers(txHash, [
      { transferIndex: 0, tokenContract: USDT_CONTRACT, fromAddress: null, toAddress: depositAddress.toLowerCase(), amount: 90_000_000n },
    ]);

    await monitor.processTransaction(adapter, NETWORK, txHash);
    await monitor.updateConfirmations(adapter, NETWORK);

    const invoice = await db.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
    expect(invoice.status).toBe('PAID');
    expect(decimalToUnits(invoice.receivedAmount)).toBe(90_000_000n);
    expect(await db.ledgerTransaction.count({ where: { invoiceId } })).toBe(1);
  });

  it('lands on OVERPAID and does not post a ledger credit under MANUAL_REVIEW', async () => {
    const merchantId = await createMerchant(db, { overpaymentPolicy: 'MANUAL_REVIEW' });
    const depositAddress = freshAddress();
    const { invoiceId } = await createPendingInvoice(db, {
      merchantId,
      network: NETWORK,
      asset: 'USDT',
      decimals: 6,
      cryptoAmountUnits: 100_000_000n,
      requiredConfirmations: 1,
      address: depositAddress,
    });

    const adapter = new FakeBlockchainAdapter(NETWORK);
    const txHash = freshHash('over');
    adapter.addBlock(
      makeTestBlock({
        number: 500n,
        hash: '0xblockO',
        parentHash: '0xblock499',
        transactions: [makeTestTransaction({ hash: txHash, blockNumber: 500n, blockHash: '0xblockO', toAddress: USDT_CONTRACT })],
      }),
    );
    adapter.setTransfers(txHash, [
      { transferIndex: 0, tokenContract: USDT_CONTRACT, fromAddress: null, toAddress: depositAddress.toLowerCase(), amount: 105_000_000n },
    ]);

    await monitor.processTransaction(adapter, NETWORK, txHash);
    await monitor.updateConfirmations(adapter, NETWORK);

    const invoice = await db.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
    expect(invoice.status).toBe('OVERPAID');
    expect(await db.ledgerTransaction.count({ where: { invoiceId } })).toBe(0);
  });

  it('auto-accepts an overpayment as PAID and credits the full amount when the policy is ACCEPT_FULL', async () => {
    const merchantId = await createMerchant(db, { overpaymentPolicy: 'ACCEPT_FULL', feeBps: 0 });
    const depositAddress = freshAddress();
    const { invoiceId } = await createPendingInvoice(db, {
      merchantId,
      network: NETWORK,
      asset: 'USDT',
      decimals: 6,
      cryptoAmountUnits: 100_000_000n,
      requiredConfirmations: 1,
      address: depositAddress,
    });

    const adapter = new FakeBlockchainAdapter(NETWORK);
    const txHash = freshHash('fullover');
    adapter.addBlock(
      makeTestBlock({
        number: 600n,
        hash: '0xblockF',
        parentHash: '0xblock599',
        transactions: [makeTestTransaction({ hash: txHash, blockNumber: 600n, blockHash: '0xblockF', toAddress: USDT_CONTRACT })],
      }),
    );
    adapter.setTransfers(txHash, [
      { transferIndex: 0, tokenContract: USDT_CONTRACT, fromAddress: null, toAddress: depositAddress.toLowerCase(), amount: 110_000_000n },
    ]);

    await monitor.processTransaction(adapter, NETWORK, txHash);
    await monitor.updateConfirmations(adapter, NETWORK);

    const invoice = await db.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
    expect(invoice.status).toBe('PAID');
    expect(decimalToUnits(invoice.receivedAmount)).toBe(110_000_000n);
  });
});

describe('unsupported asset and unmatched transfers', () => {
  it('records a transfer to an unrecognised token contract without crediting anything', async () => {
    const merchantId = await createMerchant(db);
    const depositAddress = freshAddress();
    const { invoiceId } = await createPendingInvoice(db, {
      merchantId,
      network: NETWORK,
      asset: 'USDT',
      decimals: 6,
      cryptoAmountUnits: 100_000_000n,
      address: depositAddress,
    });

    const adapter = new FakeBlockchainAdapter(NETWORK);
    const txHash = freshHash('scam');
    const scamContract = freshAddress();
    adapter.addBlock(
      makeTestBlock({
        number: 700n,
        hash: '0xblockS',
        parentHash: '0xblock699',
        transactions: [makeTestTransaction({ hash: txHash, blockNumber: 700n, blockHash: '0xblockS', toAddress: scamContract })],
      }),
    );
    adapter.setTransfers(txHash, [
      { transferIndex: 0, tokenContract: scamContract, fromAddress: null, toAddress: depositAddress.toLowerCase(), amount: 1_000_000_000n },
    ]);

    await monitor.processTransaction(adapter, NETWORK, txHash);

    const transfer = await db.tokenTransfer.findFirstOrThrow({ where: { network: NETWORK, txHash } });
    expect(transfer.matchStatus).toBe('UNSUPPORTED_ASSET');
    // The destination is still linked to the invoice it belongs to, purely
    // for forensics ("someone sent an unrecognised token to invoice X's
    // address") - matchStatus, not invoiceId, is what says it was never
    // credited.
    expect(transfer.invoiceId).toBe(invoiceId);

    const invoice = await db.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
    expect(invoice.status).toBe('PENDING'); // unaffected - nothing payable arrived
  });

  it('records a transfer to an address that is ours but claimed by no invoice as UNMATCHED', async () => {
    const merchantId = await createMerchant(db);
    const orphanAddress = freshAddress();
    await db.paymentAddress.create({
      data: {
        id: newId('paymentAddress'),
        merchantId,
        network: NETWORK,
        address: orphanAddress,
        addressNormalized: orphanAddress.toLowerCase(),
        assetSymbol: 'USDT',
        status: 'AVAILABLE',
      },
    });

    const adapter = new FakeBlockchainAdapter(NETWORK);
    const txHash = freshHash('unmatched');
    adapter.addBlock(
      makeTestBlock({
        number: 800n,
        hash: '0xblockM',
        parentHash: '0xblock799',
        transactions: [makeTestTransaction({ hash: txHash, blockNumber: 800n, blockHash: '0xblockM', toAddress: USDT_CONTRACT })],
      }),
    );
    adapter.setTransfers(txHash, [
      { transferIndex: 0, tokenContract: USDT_CONTRACT, fromAddress: null, toAddress: orphanAddress.toLowerCase(), amount: 1_000_000n },
    ]);

    await monitor.processTransaction(adapter, NETWORK, txHash);

    const transfer = await db.tokenTransfer.findFirstOrThrow({ where: { network: NETWORK, txHash } });
    expect(transfer.matchStatus).toBe('UNMATCHED');
  });
});

describe('reorg handling', () => {
  it('orphans an uncredited transfer and reverts the invoice back to PENDING', async () => {
    const merchantId = await createMerchant(db);
    const depositAddress = freshAddress();
    const { invoiceId } = await createPendingInvoice(db, {
      merchantId,
      network: NETWORK,
      asset: 'USDT',
      decimals: 6,
      cryptoAmountUnits: 100_000_000n,
      requiredConfirmations: 5,
      address: depositAddress,
    });

    const adapter = new FakeBlockchainAdapter(NETWORK);
    const txHash = freshHash('reorged');
    adapter.addBlock(
      makeTestBlock({
        number: 900n,
        hash: '0xblockR',
        parentHash: '0xblock899',
        transactions: [makeTestTransaction({ hash: txHash, blockNumber: 900n, blockHash: '0xblockR', toAddress: USDT_CONTRACT })],
      }),
    );
    adapter.setTransfers(txHash, [
      { transferIndex: 0, tokenContract: USDT_CONTRACT, fromAddress: null, toAddress: depositAddress.toLowerCase(), amount: 100_000_000n },
    ]);

    await monitor.processTransaction(adapter, NETWORK, txHash);
    let invoice = await db.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
    expect(invoice.status).toBe('DETECTED');

    // The block reorganises away before reaching the confirmation threshold.
    await monitor.handleReorg(NETWORK, 900n);

    invoice = await db.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
    expect(invoice.status).toBe('PENDING');

    const transfer = await db.tokenTransfer.findFirstOrThrow({ where: { network: NETWORK, txHash } });
    expect(transfer.matchStatus).toBe('ORPHANED');

    const chainTx = await db.blockchainTransaction.findFirstOrThrow({ where: { network: NETWORK, txHash } });
    expect(chainTx.status).toBe('ORPHANED');
  });

  it('sends an already-credited invoice to RECONCILIATION_REQUIRED instead of silently reversing it', async () => {
    const merchantId = await createMerchant(db, { feeBps: 0 });
    const depositAddress = freshAddress();
    const { invoiceId } = await createPendingInvoice(db, {
      merchantId,
      network: NETWORK,
      asset: 'USDT',
      decimals: 6,
      cryptoAmountUnits: 10_000_000n,
      requiredConfirmations: 1,
      address: depositAddress,
    });

    const adapter = new FakeBlockchainAdapter(NETWORK);
    const txHash = freshHash('paidthenreorg');
    adapter.addBlock(
      makeTestBlock({
        number: 1000n,
        hash: '0xblockRR',
        parentHash: '0xblock999',
        transactions: [makeTestTransaction({ hash: txHash, blockNumber: 1000n, blockHash: '0xblockRR', toAddress: USDT_CONTRACT })],
      }),
    );
    adapter.setTransfers(txHash, [
      { transferIndex: 0, tokenContract: USDT_CONTRACT, fromAddress: null, toAddress: depositAddress.toLowerCase(), amount: 10_000_000n },
    ]);

    await monitor.processTransaction(adapter, NETWORK, txHash);
    await monitor.updateConfirmations(adapter, NETWORK);

    let invoice = await db.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
    expect(invoice.status).toBe('PAID');

    // Now the settling block itself is reorganised away.
    await monitor.handleReorg(NETWORK, 1000n);

    invoice = await db.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
    expect(invoice.status).toBe('RECONCILIATION_REQUIRED');

    const discrepancy = await db.reconciliationDiscrepancy.findFirstOrThrow({ where: { kind: 'ORPHANED_CREDIT' } });
    expect(discrepancy.severity).toBe('CRITICAL');

    // The ledger posting itself is untouched - never silently reversed.
    const ledgerTx = await db.ledgerTransaction.findUniqueOrThrow({ where: { idempotencyKey: `credit:${NETWORK}:${txHash}:0` } });
    expect(await db.ledgerEntry.count({ where: { ledgerTransactionId: ledgerTx.id } })).toBeGreaterThan(0);
  });
});
