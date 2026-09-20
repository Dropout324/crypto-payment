import { FakeBlockchainAdapter, makeTestBlock, makeTestTransaction } from '@gateway/blockchain';
import { type PrismaClient, createPrismaClient } from '@gateway/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MonitorService } from '../src/monitor.service.js';
import { ChainScanner } from '../src/scanner.js';
import { createMerchant, createPendingInvoice, uniqueSuffix } from './support/fixtures.js';

let db: PrismaClient;
let monitor: MonitorService;

const NETWORK = 'ETHEREUM' as const;

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

/**
 * `chain_cursors` is keyed by network alone (one scan position per network,
 * process-wide) rather than per test, so every test here clears its own
 * network's row first to avoid inheriting position from a previous test.
 */
async function resetCursor(network: string): Promise<void> {
  await db.chainCursor.deleteMany({ where: { network: network as never } });
}

describe('ChainScanner', () => {
  it('discovers a native transfer to a tracked address and drives it through to PAID', async () => {
    const network = NETWORK;
    await resetCursor(network);

    const merchantId = await createMerchant(db, { feeBps: 0 });
    const depositAddress = freshAddress();
    const amount = 1_000_000_000_000_000_000n; // 1 ETH
    const { invoiceId } = await createPendingInvoice(db, {
      merchantId,
      network,
      asset: 'ETH',
      decimals: 18,
      cryptoAmountUnits: amount,
      requiredConfirmations: 1,
      address: depositAddress,
    });

    const adapter = new FakeBlockchainAdapter(network);
    adapter.addBlock(makeTestBlock({ number: 100n, hash: '0xblock100', parentHash: '0xblock99' }));

    const scanner = new ChainScanner(db, adapter, monitor, network, 50);
    await scanner.tick(); // establishes the cursor at the current tip; nothing to find yet

    const txHash = freshHash('native');
    const sender = freshAddress();
    adapter.addBlock(
      makeTestBlock({
        number: 101n,
        hash: '0xblock101',
        parentHash: '0xblock100',
        transactions: [makeTestTransaction({ hash: txHash, blockNumber: 101n, blockHash: '0xblock101', fromAddress: sender, toAddress: depositAddress })],
      }),
    );
    adapter.setTransfers(txHash, [{ transferIndex: -1, tokenContract: null, fromAddress: sender, toAddress: depositAddress.toLowerCase(), amount }]);

    const result = await scanner.tick();
    expect(result).toMatchObject({ scannedBlocks: 1, candidateTransactions: 1, reorgDetected: false, chainTip: 101n });

    const invoice = await db.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
    expect(invoice.status).toBe('PAID');

    const cursor = await db.chainCursor.findUniqueOrThrow({ where: { network } });
    expect(cursor.lastProcessedBlock).toBe(101n);
    expect(cursor.lastProcessedHash).toBe('0xblock101');
  });

  it('ignores a transaction that does not touch any tracked address', async () => {
    const network = NETWORK;
    await resetCursor(network);

    const adapter = new FakeBlockchainAdapter(network);
    adapter.addBlock(makeTestBlock({ number: 200n, hash: '0xblock200', parentHash: '0xblock199' }));

    const scanner = new ChainScanner(db, adapter, monitor, network, 50);
    await scanner.tick();

    const txHash = freshHash('untracked');
    const randomRecipient = freshAddress();
    adapter.addBlock(
      makeTestBlock({
        number: 201n,
        hash: '0xblock201',
        parentHash: '0xblock200',
        transactions: [makeTestTransaction({ hash: txHash, blockNumber: 201n, blockHash: '0xblock201', toAddress: randomRecipient })],
      }),
    );
    adapter.setTransfers(txHash, [{ transferIndex: -1, tokenContract: null, fromAddress: freshAddress(), toAddress: randomRecipient.toLowerCase(), amount: 1n }]);

    const result = await scanner.tick();
    expect(result.candidateTransactions).toBe(0);

    const recorded = await db.tokenTransfer.count({ where: { txHash } });
    expect(recorded).toBe(0); // MonitorService.processTransaction was never called for it
  });

  it('detects a reorg against the last-processed block and rewinds the cursor', async () => {
    const network = NETWORK;
    await resetCursor(network);

    const adapter = new FakeBlockchainAdapter(network);
    adapter.addBlock(makeTestBlock({ number: 300n, hash: '0xblock300', parentHash: '0xblock299' }));

    const scanner = new ChainScanner(db, adapter, monitor, network, 50);
    await scanner.tick();
    adapter.addBlock(makeTestBlock({ number: 301n, hash: '0xblock301-orig', parentHash: '0xblock300' }));
    await scanner.tick();

    let cursor = await db.chainCursor.findUniqueOrThrow({ where: { network } });
    expect(cursor.lastProcessedBlock).toBe(301n);
    expect(cursor.lastProcessedHash).toBe('0xblock301-orig');

    // Reorg: block 301 is replaced by a different one.
    adapter.reorganize(301n, [makeTestBlock({ number: 301n, hash: '0xblock301-new', parentHash: '0xblock300' })]);

    const result = await scanner.tick();
    expect(result.reorgDetected).toBe(true);

    cursor = await db.chainCursor.findUniqueOrThrow({ where: { network } });
    // Rewound to re-process from block 300 onward, then this same tick re-scanned
    // forward and landed back on the new block 301.
    expect(cursor.lastProcessedBlock).toBe(301n);
    expect(cursor.lastProcessedHash).toBe('0xblock301-new');
    expect(cursor.lastReorgAt).not.toBeNull();
  });
});
