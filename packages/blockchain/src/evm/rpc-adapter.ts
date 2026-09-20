import type { NetworkValue } from '@gateway/shared';
import { getNetworkConfig } from '@gateway/shared';
import type {
  AnyMonitorEvent,
  BlockData,
  BlockRef,
  BlockchainAdapter,
  ChainTransaction,
  ChainTransactionStatus,
  ConfirmationInfo,
  MonitorHandle,
  MonitorOptions,
  ParsedTransfer,
} from '../adapter.js';
import { BlockchainAdapterError } from '../adapter.js';
import { isStructurallyValidEvmAddress } from '../address/evm.js';
import { TRANSFER_EVENT_TOPIC, addressToTopic, nativeTransfer, parseTransferLogs, type RawEvmLog } from './transfer-log.js';
import { EvmRpcClient, type EvmRpcClientOptions, hexToBigInt, hexToNumber } from './rpc-client.js';

/**
 * `BlockchainAdapter` backed by a real EVM JSON-RPC provider (Alchemy,
 * Infura, QuickNode, a self-hosted node - anything speaking standard
 * `eth_*` JSON-RPC). One implementation serves Ethereum, Polygon and BSC
 * (and their testnets): they differ only in RPC URL and chain id, both of
 * which come from `NETWORKS`/the constructor, never from branching in this
 * file (ADR 0004).
 *
 * Every method here is exercised in `packages/blockchain-monitor` against
 * `FakeBlockchainAdapter` already - this class's only job is to produce the
 * SAME shapes (`ChainTransaction`, `ParsedTransfer`, `BlockData`) from a real
 * node's responses, never to introduce new decision logic. Money-relevant
 * decisions (is this confirmed, does this transfer match an invoice, is a
 * reorg dangerous) stay in `@gateway/payments` and `MonitorService`.
 */
export class EvmJsonRpcAdapter implements BlockchainAdapter {
  readonly network: NetworkValue;
  private readonly rpc: EvmRpcClient;

  constructor(network: NetworkValue, options: EvmRpcClientOptions) {
    const config = getNetworkConfig(network);
    if (config.family !== 'evm') {
      throw new BlockchainAdapterError(network, `EvmJsonRpcAdapter cannot serve a non-EVM network: ${network}`, { retryable: false });
    }
    this.network = network;
    this.rpc = new EvmRpcClient(network, options);
  }

  async getBalance(address: string): Promise<bigint> {
    const result = await this.rpc.call<string>('eth_getBalance', [address, 'latest']);
    return hexToBigInt(result) ?? 0n;
  }

  async getTransaction(hash: string): Promise<ChainTransaction | null> {
    const [rawTx, rawReceipt, tipHex] = await this.rpc.batch([
      { method: 'eth_getTransactionByHash', params: [hash] },
      { method: 'eth_getTransactionReceipt', params: [hash] },
      { method: 'eth_blockNumber' },
    ]);
    if (!rawTx) return null; // unknown to this node - not a transport failure

    const chainTip = hexToBigInt(tipHex as string) ?? 0n;
    return toChainTransaction(rawTx as RawEvmTx, rawReceipt as RawEvmReceipt | null, chainTip);
  }

  async getTransfers(hash: string): Promise<ParsedTransfer[]> {
    const [rawTx, rawReceipt] = await this.rpc.batch([
      { method: 'eth_getTransactionByHash', params: [hash] },
      { method: 'eth_getTransactionReceipt', params: [hash] },
    ]);
    const tx = rawTx as RawEvmTx | null;
    const receipt = rawReceipt as RawEvmReceipt | null;
    if (!tx || !receipt) return []; // not yet mined (or unknown) - nothing confirmed to parse yet

    // A reverted transaction moved no value at the EVM level, regardless of
    // what tx.value claims - crediting from it would credit something that
    // never actually happened on-chain.
    if (receipt.status !== '0x1') return [];

    const transfers: ParsedTransfer[] = [];
    if (tx.to) {
      const native = nativeTransfer({ fromAddress: tx.from, toAddress: tx.to, value: hexToBigInt(tx.value) ?? 0n });
      if (native) transfers.push(native);
    }
    transfers.push(...parseTransferLogs(receipt.logs.map(toRawEvmLog)));
    return transfers;
  }

  async getBlock(numberOrHash: bigint | string): Promise<BlockData | null> {
    const rawBlock = await this.rpc.call<RawEvmBlock | null>(
      typeof numberOrHash === 'bigint' ? 'eth_getBlockByNumber' : 'eth_getBlockByHash',
      [typeof numberOrHash === 'bigint' ? toHexQuantity(numberOrHash) : numberOrHash, true],
    );
    if (!rawBlock) return null;

    const txHashes = rawBlock.transactions.map((tx) => tx.hash);
    const receiptsById = await this.fetchReceiptsByHash(txHashes);
    const chainTip = hexToBigInt(rawBlock.number) ?? 0n;

    return {
      number: chainTip,
      hash: rawBlock.hash,
      parentHash: rawBlock.parentHash,
      timestamp: new Date((hexToNumber(rawBlock.timestamp) ?? 0) * 1000),
      transactions: rawBlock.transactions.map((tx) => toChainTransaction(tx, receiptsById.get(tx.hash.toLowerCase()) ?? null, chainTip)),
    };
  }

  /**
   * Cheap block read for DISCOVERY only: hash/parentHash plus each
   * transaction's hash/to/value, with NO per-transaction receipt fetch.
   *
   * Not part of `BlockchainAdapter` - it exists so `ChainScanner` can find
   * candidate native-transfer transactions without `getBlock`'s cost (a
   * receipt fetch for every transaction in the block), which is what made a
   * busy mainnet block exhaust a free RPC tier's rate limit in minutes (ADR
   * 0010). A caller still confirms anything it finds via the real interface
   * methods (`getTransaction`/`getTransfers`) before treating it as real.
   */
  async getLightBlock(numberOrHash: bigint | string): Promise<EvmLightBlock | null> {
    const rawBlock = await this.rpc.call<RawEvmBlock | null>(
      typeof numberOrHash === 'bigint' ? 'eth_getBlockByNumber' : 'eth_getBlockByHash',
      [typeof numberOrHash === 'bigint' ? toHexQuantity(numberOrHash) : numberOrHash, true],
    );
    if (!rawBlock) return null;
    return {
      number: hexToBigInt(rawBlock.number) ?? 0n,
      hash: rawBlock.hash,
      parentHash: rawBlock.parentHash,
      transactions: rawBlock.transactions.map((tx) => ({ hash: tx.hash, to: tx.to, value: hexToBigInt(tx.value) ?? 0n })),
    };
  }

  /**
   * Transfer-log discovery across a block range in ONE round trip, filtered
   * server-side to the given token contracts and recipient addresses -
   * `eth_getLogs`'s topic filter supports an OR match on a list of indexed
   * values, so this asks the provider "which of these contracts' Transfer
   * events went to any of these addresses", rather than fetching every
   * transaction's receipt and checking client-side (ADR 0010).
   */
  async getTransferLogsTo(fromBlock: bigint, toBlock: bigint, contracts: readonly string[], toAddresses: readonly string[]): Promise<string[]> {
    if (contracts.length === 0 || toAddresses.length === 0) return [];
    const logs = await this.rpc.call<Array<{ transactionHash: string }>>('eth_getLogs', [
      {
        fromBlock: toHexQuantity(fromBlock),
        toBlock: toHexQuantity(toBlock),
        address: contracts,
        topics: [TRANSFER_EVENT_TOPIC, null, toAddresses.map(addressToTopic)],
      },
    ]);
    return [...new Set(logs.map((log) => log.transactionHash))];
  }

  async getCurrentBlock(): Promise<BlockRef> {
    const tipHex = await this.rpc.call<string>('eth_blockNumber');
    const header = await this.rpc.call<RawEvmBlock | null>('eth_getBlockByNumber', [tipHex, false]);
    if (!header) {
      throw new BlockchainAdapterError(this.network, 'provider reported a block number it cannot return a header for', { retryable: true });
    }
    return {
      number: hexToBigInt(header.number) ?? 0n,
      hash: header.hash,
      parentHash: header.parentHash,
      timestamp: new Date((hexToNumber(header.timestamp) ?? 0) * 1000),
    };
  }

  async getConfirmations(hash: string): Promise<ConfirmationInfo> {
    const [rawTx, tipHex] = await this.rpc.batch([
      { method: 'eth_getTransactionByHash', params: [hash] },
      { method: 'eth_blockNumber' },
    ]);
    const tx = rawTx as RawEvmTx | null;
    const chainTip = hexToBigInt(tipHex as string) ?? 0n;

    const blockNumber = tx ? hexToBigInt(tx.blockNumber) : null;
    if (blockNumber === null) return { confirmations: 0, blockNumber: null, chainTip };

    const confirmations = chainTip >= blockNumber ? Number(chainTip - blockNumber + 1n) : 0;
    return { confirmations, blockNumber, chainTip };
  }

  validateAddress = (address: string): boolean => isStructurallyValidEvmAddress(address);

  /**
   * No WebSocket configured for every network yet, so this polls
   * `getCurrentBlock` - which the interface explicitly permits ("every
   * implementation MUST be safe to poll instead"). Emits `block` for each new
   * tip and a best-effort `reorg` when the hash at a previously-seen height
   * changes. `MonitorService` never trusts this signal by itself either way -
   * it always re-fetches via `processTransaction`/`updateConfirmations`.
   */
  async monitorTransactions(options: MonitorOptions): Promise<MonitorHandle> {
    let lastSeen: BlockRef | null = null;
    let stopped = false;

    const tick = async (): Promise<void> => {
      if (stopped) return;
      try {
        const current = await this.getCurrentBlock();
        if (!lastSeen || current.hash !== lastSeen.hash) {
          if (lastSeen && current.number <= lastSeen.number) {
            this.emit(options, { type: 'reorg', network: this.network, fromBlock: current.number, newTip: current.number });
          } else {
            this.emit(options, { type: 'block', network: this.network, block: current });
          }
          lastSeen = current;
        }
      } catch (error) {
        options.onError(error instanceof Error ? error : new Error(String(error)));
      }
    };

    const config = getNetworkConfig(this.network);
    const interval = setInterval(() => void tick(), Math.max(1000, config.averageBlockSeconds * 1000));
    void tick();

    return {
      stop: async () => {
        stopped = true;
        clearInterval(interval);
      },
    };
  }

  private emit(options: MonitorOptions, event: AnyMonitorEvent): void {
    try {
      options.onEvent(event);
    } catch (error) {
      options.onError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private async fetchReceiptsByHash(hashes: string[]): Promise<Map<string, RawEvmReceipt>> {
    if (hashes.length === 0) return new Map();
    const receipts = await this.rpc.batch(hashes.map((hash) => ({ method: 'eth_getTransactionReceipt', params: [hash] })));
    const byHash = new Map<string, RawEvmReceipt>();
    hashes.forEach((hash, index) => {
      const receipt = receipts[index] as RawEvmReceipt | null;
      if (receipt) byHash.set(hash.toLowerCase(), receipt);
    });
    return byHash;
  }
}

export interface EvmLightBlock {
  number: bigint;
  hash: string;
  parentHash: string;
  transactions: Array<{ hash: string; to: string | null; value: bigint }>;
}

export function toHexQuantity(value: bigint): string {
  if (value < 0n) throw new RangeError(`cannot encode a negative quantity: ${value}`);
  return `0x${value.toString(16)}`;
}

// ---------------------------------------------------------------------------
// Raw provider shapes (standard Ethereum JSON-RPC - the same fields every
// provider in scope returns) and their mapping into this package's types.
// ---------------------------------------------------------------------------

interface RawEvmTx {
  hash: string;
  blockNumber: string | null;
  blockHash: string | null;
  transactionIndex: string | null;
  from: string;
  to: string | null;
  value: string;
  gasPrice?: string;
}

interface RawEvmReceipt {
  status: '0x1' | '0x0';
  gasUsed: string;
  effectiveGasPrice?: string;
  logs: Array<{ address: string; topics: string[]; data: string; logIndex: string }>;
}

interface RawEvmBlock {
  number: string;
  hash: string;
  parentHash: string;
  timestamp: string;
  transactions: RawEvmTx[];
}

function toRawEvmLog(log: RawEvmReceipt['logs'][number]): RawEvmLog {
  return { address: log.address, topics: log.topics, data: log.data, logIndex: hexToNumber(log.logIndex) ?? 0 };
}

function toChainTransaction(tx: RawEvmTx, receipt: RawEvmReceipt | null, chainTip: bigint): ChainTransaction {
  const blockNumber = hexToBigInt(tx.blockNumber);
  const status: ChainTransactionStatus = !receipt ? 'PENDING' : receipt.status === '0x1' ? 'SUCCESS' : 'REVERTED';
  const confirmations = blockNumber !== null && chainTip >= blockNumber ? Number(chainTip - blockNumber + 1n) : 0;

  const gasPrice = receipt?.effectiveGasPrice ?? tx.gasPrice;
  const feeAmount = receipt && gasPrice ? (hexToBigInt(receipt.gasUsed) ?? 0n) * (hexToBigInt(gasPrice) ?? 0n) : null;

  return {
    hash: tx.hash,
    blockNumber,
    blockHash: tx.blockHash,
    transactionIndex: hexToNumber(tx.transactionIndex),
    status,
    fromAddress: tx.from,
    toAddress: tx.to,
    value: hexToBigInt(tx.value) ?? 0n,
    feeAmount,
    confirmations,
    raw: { tx, receipt },
  };
}
