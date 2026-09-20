import type {
  BlockData,
  BlockRef,
  BlockchainAdapter,
  ChainTransaction,
  ConfirmationInfo,
  EvmLightBlock,
  MonitorHandle,
  ParsedTransfer,
} from '@gateway/blockchain';
import { createPrismaClient, type PrismaClient } from '@gateway/database';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ChainScanner, type MonitorServiceLike } from '../src/scanner.js';
import { createMerchant, createPendingInvoice, uniqueSuffix } from './support/fixtures.js';

let db: PrismaClient;

const NETWORK = 'ETHEREUM' as const;

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
async function resetCursor(network: string): Promise<void> {
  await db.chainCursor.deleteMany({ where: { network: network as never } });
}

/**
 * Implements ONLY what `ChainScanner`'s fast path calls, throwing on
 * everything else - if the scanner ever falls back to the expensive generic
 * path (`getBlock`, `getTransfers`) while this adapter is in play, the test
 * fails loudly instead of silently passing via the slow path.
 */
class FastPathOnlyAdapter implements BlockchainAdapter {
  readonly network = NETWORK;
  currentBlock!: BlockRef;
  private readonly lightBlocks = new Map<string, EvmLightBlock>();
  transferLogsToCalls: Array<{ from: bigint; to: bigint; contracts: string[]; addresses: string[] }> = [];
  transferLogsResult: string[] = [];

  setLightBlock(block: EvmLightBlock): void {
    this.lightBlocks.set(block.number.toString(), block);
  }

  async getCurrentBlock(): Promise<BlockRef> {
    return this.currentBlock;
  }

  async getLightBlock(numberOrHash: bigint | string): Promise<EvmLightBlock | null> {
    return this.lightBlocks.get(String(numberOrHash)) ?? null;
  }

  async getTransferLogsTo(fromBlock: bigint, toBlock: bigint, contracts: readonly string[], toAddresses: readonly string[]): Promise<string[]> {
    this.transferLogsToCalls.push({ from: fromBlock, to: toBlock, contracts: [...contracts], addresses: [...toAddresses] });
    return this.transferLogsResult;
  }

  async getBalance(): Promise<bigint> {
    throw new Error('not needed by the fast discovery path');
  }
  async getTransaction(): Promise<ChainTransaction | null> {
    throw new Error('discovery must not call getTransaction directly - only MonitorService.processTransaction does');
  }
  async getTransfers(): Promise<ParsedTransfer[]> {
    throw new Error('the fast path must not call getTransfers per-transaction - that is the whole optimisation (ADR 0010)');
  }
  async getBlock(): Promise<BlockData | null> {
    throw new Error('the fast path must not call getBlock (expensive per-tx receipt fetch) when getLightBlock is available');
  }
  async getConfirmations(): Promise<ConfirmationInfo> {
    throw new Error('not needed in this test');
  }
  validateAddress = (): boolean => true;
  async monitorTransactions(): Promise<MonitorHandle> {
    throw new Error('not needed in this test');
  }
}

describe('ChainScanner fast EVM discovery path', () => {
  it('uses getLightBlock + getTransferLogsTo (never getBlock/getTransfers) and calls the monitor only for real candidates', async () => {
    await resetCursor(NETWORK);

    const merchantId = await createMerchant(db);
    const trackedAddress = freshAddress().toLowerCase();
    await createPendingInvoice(db, {
      merchantId,
      network: NETWORK,
      asset: 'ETH',
      decimals: 18,
      cryptoAmountUnits: 1n,
      requiredConfirmations: 1,
      address: trackedAddress,
    });

    const adapter = new FastPathOnlyAdapter();
    adapter.currentBlock = { number: 100n, hash: '0xb100', parentHash: '0xb99', timestamp: new Date() };
    adapter.setLightBlock({ number: 100n, hash: '0xb100', parentHash: '0xb99', transactions: [] });

    const monitor: MonitorServiceLike = {
      processTransaction: vi.fn(async () => {}),
      updateConfirmations: vi.fn(async () => {}),
      handleReorg: vi.fn(async () => {}),
    };

    const scanner = new ChainScanner(db, adapter, monitor, NETWORK, 50);
    await scanner.tick(); // establishes the cursor at the tip; nothing to find in the empty block 100
    adapter.transferLogsToCalls = []; // that tick's own getTransferLogsTo call is not what this test is about

    const trackedTxHash = freshHash('tracked');
    const untrackedTxHash = freshHash('untracked');
    adapter.currentBlock = { number: 101n, hash: '0xb101', parentHash: '0xb100', timestamp: new Date() };
    adapter.setLightBlock({
      number: 101n,
      hash: '0xb101',
      parentHash: '0xb100',
      transactions: [
        { hash: trackedTxHash, to: trackedAddress, value: 1n },
        { hash: untrackedTxHash, to: freshAddress(), value: 1n },
      ],
    });

    const result = await scanner.tick();

    expect(result).toMatchObject({ scannedBlocks: 1, candidateTransactions: 1, chainTip: 101n });
    expect(monitor.processTransaction).toHaveBeenCalledTimes(1);
    expect(monitor.processTransaction).toHaveBeenCalledWith(adapter, NETWORK, trackedTxHash);

    expect(adapter.transferLogsToCalls).toHaveLength(1);
    const logCall = adapter.transferLogsToCalls[0]!;
    expect(logCall.from).toBe(101n);
    expect(logCall.to).toBe(101n);
    // `addresses` is every ASSIGNED/RETIRED address on this network, process-wide
    // (correct: the scanner watches every merchant, not just this test's) - so
    // this only asserts the test's own address is among them, not that it's alone.
    expect(logCall.addresses).toContain(trackedAddress);
    // ETHEREUM has allowlisted USDT/USDC contracts - the fast path must pass
    // them so eth_getLogs can filter server-side instead of client-side.
    expect(logCall.contracts.length).toBeGreaterThan(0);
  });

  it('folds getTransferLogsTo hits into the candidate set alongside native matches', async () => {
    await resetCursor(NETWORK);

    const adapter = new FastPathOnlyAdapter();
    adapter.currentBlock = { number: 200n, hash: '0xb200', parentHash: '0xb199', timestamp: new Date() };
    adapter.setLightBlock({ number: 200n, hash: '0xb200', parentHash: '0xb199', transactions: [] });

    const monitor: MonitorServiceLike = {
      processTransaction: vi.fn(async () => {}),
      updateConfirmations: vi.fn(async () => {}),
      handleReorg: vi.fn(async () => {}),
    };
    const scanner = new ChainScanner(db, adapter, monitor, NETWORK, 50);
    await scanner.tick();

    const tokenTxHash = freshHash('token');
    adapter.currentBlock = { number: 201n, hash: '0xb201', parentHash: '0xb200', timestamp: new Date() };
    adapter.setLightBlock({ number: 201n, hash: '0xb201', parentHash: '0xb200', transactions: [] }); // no native match
    adapter.transferLogsResult = [tokenTxHash]; // but a Transfer log matched

    const result = await scanner.tick();

    expect(result.candidateTransactions).toBe(1);
    expect(monitor.processTransaction).toHaveBeenCalledWith(adapter, NETWORK, tokenTxHash);
  });
});
