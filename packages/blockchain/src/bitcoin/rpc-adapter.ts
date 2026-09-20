import type { NetworkValue } from '@gateway/shared';
import { getNetworkConfig, Network } from '@gateway/shared';
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
import { BlockchainAdapterError } from '../adapter.js';
import { isValidBitcoinAddress, normalizeBitcoinAddress } from '../address/bitcoin.js';
import { BitcoinRpcClient, BitcoinRpcError, RPC_INVALID_ADDRESS_OR_KEY, btcToSatoshis, type BitcoinRpcClientOptions } from './rpc-client.js';

/**
 * `BlockchainAdapter` backed by a real Bitcoin Core (`bitcoind`) JSON-RPC
 * node, run with `-txindex=1` so arbitrary transactions can be looked up by
 * hash without a block hint.
 *
 * UTXO, not account-based (ADR 0027): a Bitcoin transaction has no single
 * "to" address, only a set of outputs - each output is its own
 * `ParsedTransfer`, `transferIndex` is the output (vout) index, and there is
 * no analogue of an EVM revert (a mined Bitcoin transaction is final unless
 * the block itself is reorganised away, which `ChainScanner`'s existing
 * reorg handling already covers generically).
 *
 * Deliberately minimal relative to `EvmJsonRpcAdapter`: no fromAddress (would
 * need a prevout lookup per input - not needed for any credit decision, which
 * is keyed on the receiving output only) and no fee amount (same reason).
 * `getBalance` is real but expensive (`scantxoutset` walks the UTXO set) -
 * documented on the method, and unused by any credit-path code in this
 * codebase (transfers, not balances, drive crediting - see the interface
 * doc comment on `getBalance`).
 */
export class BitcoinRpcAdapter implements BlockchainAdapter {
  readonly network: NetworkValue;
  private readonly rpc: BitcoinRpcClient;

  constructor(network: NetworkValue, options: BitcoinRpcClientOptions) {
    const config = getNetworkConfig(network);
    if (config.family !== 'bitcoin') {
      throw new BlockchainAdapterError(network, `BitcoinRpcAdapter cannot serve a non-Bitcoin network: ${network}`, { retryable: false });
    }
    this.network = network;
    this.rpc = new BitcoinRpcClient(network, options);
  }

  /**
   * Real, but expensive: `scantxoutset` walks the full UTXO set on every
   * call - there is no indexed "balance of an arbitrary address" RPC in
   * Bitcoin Core without a wallet import or an external indexer. Unused by
   * any credit-path code (see the class comment); acceptable for the
   * interface's completeness, not for a hot path. A production deployment
   * watching many addresses at volume should front this with a real indexer
   * (e.g. Electrs) rather than call it per address.
   */
  async getBalance(address: string): Promise<bigint> {
    const result = await this.call<{ total_amount: number }>('scantxoutset', ['start', [{ desc: `addr(${address})` }]]);
    return btcToSatoshis(result.total_amount);
  }

  async getTransaction(hash: string): Promise<ChainTransaction | null> {
    const tx = await this.getRawTransaction(hash);
    if (!tx) return null;

    const chainTip = await this.call<number>('getblockcount');
    return this.toChainTransaction(tx, BigInt(chainTip));
  }

  async getTransfers(hash: string): Promise<ParsedTransfer[]> {
    const tx = await this.getRawTransaction(hash);
    // Mirrors `EvmJsonRpcAdapter.getTransfers` refusing to parse an unmined
    // transaction: an unconfirmed Bitcoin transaction can still be replaced
    // (RBF) or simply never mined, so nothing here is safe to treat as a
    // real transfer until it is actually in a block.
    if (!tx || !tx.blockhash) return [];

    const kind = this.network === Network.BITCOIN ? 'mainnet' : 'testnet';
    const transfers: ParsedTransfer[] = [];
    for (const vout of tx.vout) {
      const address = vout.scriptPubKey.address ?? vout.scriptPubKey.addresses?.[0];
      if (!address) continue; // OP_RETURN or other non-standard output - nothing to credit

      // Matches the DB's `PaymentAddress.addressNormalized` byte-for-byte, the
      // same way `EvmJsonRpcAdapter` normalizes at the source rather than
      // leaving comparison-time normalization to callers (see `ChainScanner`'s
      // `normalizeForTracking`). A node only ever reports its own valid
      // address encodings, so this should never throw in practice - the
      // catch exists so one unrecognised output can never take down an
      // entire transaction's worth of otherwise-good transfers.
      let normalized: string;
      try {
        normalized = normalizeBitcoinAddress(address, kind);
      } catch {
        continue;
      }

      transfers.push({
        transferIndex: vout.n,
        tokenContract: null,
        fromAddress: null,
        toAddress: normalized,
        amount: btcToSatoshis(vout.value),
      });
    }
    return transfers;
  }

  /**
   * Verbosity 1 (txids only), not 2 (every transaction fully decoded) -
   * found necessary by a real live-mainnet run
   * (`test/bitcoin/rpc-adapter.live.test.ts`), not assumed up front: a busy
   * real block can hold several thousand transactions, and decoding every
   * one of them costs enough that this timed out against a real hosted
   * provider. `ChainScanner`'s generic scan path (the only real caller - see
   * `apps/blockchain-monitor/src/scanner.ts`) only ever reads each entry's
   * `hash` from here before deciding, per candidate, whether to call
   * `getTransaction`/`getTransfers` for the real data - exactly the same
   * "cheap discovery, confirm only what matters" shape ADR 0010 already
   * established for `EvmJsonRpcAdapter.getLightBlock`, just folded into
   * `getBlock` itself here rather than a separate method, since nothing in
   * this codebase calls Bitcoin's `getBlock` expecting a fully-populated
   * per-transaction `value`/`toAddress`/`feeAmount` - only `getTransaction`/
   * `getTransfers` promise that, and still do.
   */
  async getBlock(numberOrHash: bigint | string): Promise<BlockData | null> {
    const hash = typeof numberOrHash === 'bigint' ? await this.blockHashAt(numberOrHash) : numberOrHash;
    if (!hash) return null;

    const block = await this.call<RawBitcoinBlockVerbosity1 | null>('getblock', [hash, 1]).catch((error) => rethrowUnlessNotFound(error));
    if (!block) return null;

    return {
      number: BigInt(block.height),
      hash: block.hash,
      parentHash: block.previousblockhash ?? '0'.repeat(64),
      timestamp: new Date(block.time * 1000),
      transactions: block.tx.map((txid, index) => ({
        hash: txid,
        blockNumber: BigInt(block.height),
        blockHash: block.hash,
        transactionIndex: index,
        status: 'SUCCESS',
        // Not available at this verbosity, and not needed here - see the
        // method comment. A real caller gets these from `getTransaction`/
        // `getTransfers`, which `ChainScanner` always calls before treating
        // anything as real.
        fromAddress: null,
        toAddress: null,
        value: 0n,
        feeAmount: null,
        confirmations: 0,
        raw: null,
      })),
    };
  }

  async getCurrentBlock(): Promise<BlockRef> {
    const hash = await this.call<string>('getbestblockhash');
    const header = await this.call<RawBitcoinBlockHeader>('getblockheader', [hash]);
    return {
      number: BigInt(header.height),
      hash: header.hash,
      parentHash: header.previousblockhash ?? '0'.repeat(64),
      timestamp: new Date(header.time * 1000),
    };
  }

  async getConfirmations(hash: string): Promise<ConfirmationInfo> {
    const chainTip = BigInt(await this.call<number>('getblockcount'));
    const tx = await this.getRawTransaction(hash);
    if (!tx || tx.confirmations === undefined || tx.confirmations === 0) {
      return { confirmations: 0, blockNumber: null, chainTip };
    }

    const blockNumber = chainTip - BigInt(tx.confirmations) + 1n;
    return { confirmations: tx.confirmations, blockNumber, chainTip };
  }

  validateAddress = (address: string): boolean => isValidBitcoinAddress(address, this.network === Network.BITCOIN ? 'mainnet' : 'testnet');

  /**
   * No block-notification stream configured (`-zmqpubhashblock` is a deploy-
   * time node setting, not something this adapter can assume), so - exactly
   * like `EvmJsonRpcAdapter` - this polls `getCurrentBlock`, which the
   * interface explicitly permits. `ChainScanner`/`MonitorService` never trust
   * this signal by itself; every event still triggers a real re-fetch.
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

  private async call<T>(method: string, params: unknown[] = []): Promise<T> {
    return this.rpc.call<T>(method, params);
  }

  /** `null` for an unknown txid - matches every other "not found" path in this adapter (never a throw). */
  private async getRawTransaction(hash: string): Promise<RawBitcoinTransaction | null> {
    try {
      return await this.call<RawBitcoinTransaction>('getrawtransaction', [hash, true]);
    } catch (error) {
      if (error instanceof BitcoinRpcError && error.code === RPC_INVALID_ADDRESS_OR_KEY) return null;
      throw error;
    }
  }

  private async blockHashAt(height: bigint): Promise<string | null> {
    try {
      return await this.call<string>('getblockhash', [Number(height)]);
    } catch (error) {
      if (error instanceof BitcoinRpcError && error.code === RPC_INVALID_ADDRESS_OR_KEY) return null;
      throw error;
    }
  }

  private toChainTransaction(tx: RawBitcoinTransaction, chainTip: bigint, transactionIndex: number | null = null): ChainTransaction {
    const confirmations = tx.confirmations ?? 0;
    const blockNumber = confirmations > 0 ? chainTip - BigInt(confirmations) + 1n : null;
    const firstOutput = tx.vout.find((vout) => vout.scriptPubKey.address ?? vout.scriptPubKey.addresses?.[0]);
    const totalOutputValue = tx.vout.reduce((sum, vout) => sum + btcToSatoshis(vout.value), 0n);

    return {
      hash: tx.txid,
      blockNumber,
      blockHash: tx.blockhash ?? null,
      transactionIndex,
      // Bitcoin has no revert: once mined, a transaction is final unless the
      // block itself is reorganised away (handled separately, by hash - see
      // the class comment).
      status: blockNumber !== null ? 'SUCCESS' : 'PENDING',
      fromAddress: null, // would need a prevout lookup per input - not needed for any credit decision
      toAddress: firstOutput?.scriptPubKey.address ?? firstOutput?.scriptPubKey.addresses?.[0] ?? null,
      value: totalOutputValue,
      feeAmount: null, // same reason as fromAddress
      confirmations,
      raw: tx,
    };
  }
}

function rethrowUnlessNotFound(error: unknown): null {
  if (error instanceof BitcoinRpcError && error.code === RPC_INVALID_ADDRESS_OR_KEY) return null;
  throw error;
}

// ---------------------------------------------------------------------------
// Raw provider shapes (Bitcoin Core JSON-RPC - verbose/verbosity-2 responses)
// and their mapping into this package's types.
// ---------------------------------------------------------------------------

interface RawScriptPubKey {
  /** Bitcoin Core >= 22. */
  address?: string;
  /** Bitcoin Core < 22 (deprecated, still seen on older nodes). */
  addresses?: string[];
}

interface RawVout {
  value: number;
  n: number;
  scriptPubKey: RawScriptPubKey;
}

interface RawBitcoinTransaction {
  txid: string;
  vout: RawVout[];
  /** Present once mined; absent (or 0) while the transaction is only in the mempool. */
  confirmations?: number;
  blockhash?: string;
}

/** `getblock` verbosity 1: transactions as bare txids, not decoded - see `getBlock`'s comment for why. */
interface RawBitcoinBlockVerbosity1 {
  hash: string;
  height: number;
  previousblockhash?: string; // absent only for the genesis block
  time: number;
  tx: string[];
}

interface RawBitcoinBlockHeader {
  hash: string;
  height: number;
  previousblockhash?: string;
  time: number;
}
