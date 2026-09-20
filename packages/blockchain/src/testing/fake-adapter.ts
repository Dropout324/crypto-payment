import type { NetworkValue } from '@gateway/shared';
import type {
  AnyMonitorEvent,
  BlockData,
  BlockRef,
  BlockchainAdapter,
  ChainTransaction,
  ConfirmationInfo,
  MonitorHandle,
  MonitorOptions,
  ParsedTransfer,
} from '../adapter.js';
import { isStructurallyValidEvmAddress } from '../address/evm.js';

/**
 * In-memory `BlockchainAdapter` for tests.
 *
 * This is the seam that lets the monitor, the matcher and the confirmation
 * engine (Phase 4) be built and fully tested BEFORE a real RPC provider is
 * available: they depend only on this interface, and this fake drives it from
 * data the test constructs, including reorgs.
 *
 * Not a mocking library wrapper - a real, minimal implementation of the
 * contract, so a test using it exercises the same code path a real adapter
 * would.
 */
export class FakeBlockchainAdapter implements BlockchainAdapter {
  readonly network: NetworkValue;

  private blocks: BlockData[] = [];
  private readonly transactionsByHash = new Map<string, ChainTransaction>();
  private readonly transfersByHash = new Map<string, ParsedTransfer[]>();
  private readonly balances = new Map<string, bigint>();
  private readonly listeners = new Set<(event: AnyMonitorEvent) => void>();

  constructor(network: NetworkValue) {
    this.network = network;
  }

  // --- Test setup -----------------------------------------------------------

  /** Append a new block to the tip. Emits a 'block' event to any subscriber. */
  addBlock(block: BlockData): void {
    this.blocks.push(block);
    for (const tx of block.transactions) {
      this.transactionsByHash.set(tx.hash.toLowerCase(), tx);
    }
    this.emit({ type: 'block', network: this.network, block: toBlockRef(block) });
  }

  setTransfers(hash: string, transfers: ParsedTransfer[]): void {
    this.transfersByHash.set(hash.toLowerCase(), transfers);
  }

  setBalance(address: string, units: bigint): void {
    this.balances.set(address.toLowerCase(), units);
  }

  /**
   * Simulate a reorg: truncate the chain back to `fromBlock` (exclusive) and
   * replace what follows with `replacementBlocks`. Emits a 'reorg' event
   * before replaying the new blocks as 'block' events, mirroring what a real
   * monitor observes.
   */
  reorganize(fromBlock: bigint, replacementBlocks: BlockData[]): void {
    this.blocks = this.blocks.filter((b) => b.number < fromBlock);

    for (const tx of this.blocks.flatMap((b) => b.transactions)) {
      this.transactionsByHash.set(tx.hash.toLowerCase(), tx);
    }
    // Transactions that only existed in the orphaned blocks are removed - a
    // real node would report them as no longer mined (back to mempool or gone).
    const survivingHashes = new Set(this.blocks.flatMap((b) => b.transactions.map((t) => t.hash.toLowerCase())));
    for (const hash of this.transactionsByHash.keys()) {
      if (!survivingHashes.has(hash) && !replacementBlocks.some((b) => b.transactions.some((t) => t.hash.toLowerCase() === hash))) {
        this.transactionsByHash.delete(hash);
      }
    }

    const newTip = replacementBlocks.length > 0
      ? (replacementBlocks[replacementBlocks.length - 1] as BlockData).number
      : (this.blocks[this.blocks.length - 1]?.number ?? 0n);

    this.emit({ type: 'reorg', network: this.network, fromBlock, newTip });

    for (const block of replacementBlocks) {
      this.addBlock(block);
    }
  }

  // --- BlockchainAdapter ------------------------------------------------------

  async getBalance(address: string): Promise<bigint> {
    return this.balances.get(address.toLowerCase()) ?? 0n;
  }

  async getTransaction(hash: string): Promise<ChainTransaction | null> {
    return this.transactionsByHash.get(hash.toLowerCase()) ?? null;
  }

  async getTransfers(hash: string): Promise<ParsedTransfer[]> {
    return this.transfersByHash.get(hash.toLowerCase()) ?? [];
  }

  async getBlock(numberOrHash: bigint | string): Promise<BlockData | null> {
    const block =
      typeof numberOrHash === 'bigint'
        ? this.blocks.find((b) => b.number === numberOrHash)
        : this.blocks.find((b) => b.hash.toLowerCase() === numberOrHash.toLowerCase());
    return block ?? null;
  }

  async getCurrentBlock(): Promise<BlockRef> {
    const tip = this.blocks[this.blocks.length - 1];
    if (!tip) throw new Error('FakeBlockchainAdapter has no blocks yet');
    return toBlockRef(tip);
  }

  async getConfirmations(hash: string): Promise<ConfirmationInfo> {
    const tx = this.transactionsByHash.get(hash.toLowerCase());
    const tip = this.blocks[this.blocks.length - 1];
    const chainTip = tip?.number ?? 0n;

    if (!tx || tx.blockNumber === null) {
      return { confirmations: 0, blockNumber: null, chainTip };
    }

    const confirmations = chainTip >= tx.blockNumber ? Number(chainTip - tx.blockNumber + 1n) : 0;
    return { confirmations, blockNumber: tx.blockNumber, chainTip };
  }

  validateAddress = (address: string): boolean => isStructurallyValidEvmAddress(address);

  async monitorTransactions(options: MonitorOptions): Promise<MonitorHandle> {
    const listener = (event: AnyMonitorEvent): void => {
      try {
        options.onEvent(event);
      } catch (error) {
        options.onError(error instanceof Error ? error : new Error(String(error)));
      }
    };
    this.listeners.add(listener);
    return {
      stop: async () => {
        this.listeners.delete(listener);
      },
    };
  }

  private emit(event: AnyMonitorEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

function toBlockRef(block: BlockData): BlockRef {
  return {
    number: block.number,
    hash: block.hash,
    parentHash: block.parentHash,
    timestamp: block.timestamp,
  };
}

/** Build a minimal synthetic block for tests, filling in sane defaults. */
export function makeTestBlock(params: {
  number: bigint;
  hash: string;
  parentHash: string;
  timestamp?: Date;
  transactions?: ChainTransaction[];
}): BlockData {
  return {
    number: params.number,
    hash: params.hash,
    parentHash: params.parentHash,
    timestamp: params.timestamp ?? new Date(),
    transactions: params.transactions ?? [],
  };
}

/** Build a minimal synthetic mined transaction for tests. */
export function makeTestTransaction(params: {
  hash: string;
  blockNumber: bigint;
  blockHash: string;
  transactionIndex?: number;
  fromAddress?: string | null;
  toAddress?: string | null;
  value?: bigint;
  status?: ChainTransaction['status'];
}): ChainTransaction {
  return {
    hash: params.hash,
    blockNumber: params.blockNumber,
    blockHash: params.blockHash,
    transactionIndex: params.transactionIndex ?? 0,
    status: params.status ?? 'SUCCESS',
    fromAddress: params.fromAddress ?? null,
    toAddress: params.toAddress ?? null,
    value: params.value ?? 0n,
    feeAmount: null,
    confirmations: 0,
    raw: null,
  };
}
