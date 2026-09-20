import type { BlockchainAdapter, EvmLightBlock } from '@gateway/blockchain';
import type { DatabaseClient, Network } from '@gateway/database';
import { listAssets } from '@gateway/shared';

/**
 * Discovers which transactions are worth feeding to `MonitorService`.
 *
 * `MonitorService.processTransaction` re-verifies and RECORDS whatever it is
 * given - including writing a `token_transfers` row for every transfer in
 * the transaction - so it must never be called for chain activity that has
 * nothing to do with this gateway. `ChainScanner`'s only job is that
 * filter: walk newly-seen blocks and hand the monitor only the hashes of
 * transactions that touch one of OUR tracked deposit addresses.
 *
 * Position is persisted in `chain_cursors` (`ChainCursor`) so a restart
 * resumes rather than re-scanning from genesis or silently skipping blocks.
 *
 * DISCOVERY STRATEGY (ADR 0010, revised): when `adapter` exposes
 * `EvmJsonRpcAdapter`'s cheap discovery methods (`getLightBlock`,
 * `getTransferLogsTo` - feature-detected, not a hard dependency), native
 * transfers are found from a block read with NO per-transaction receipt
 * fetch, and token transfers are found with ONE `eth_getLogs` call across
 * the whole scanned range, filtered server-side to allowlisted contracts and
 * tracked addresses. This was not a hypothetical optimisation: the first
 * version of this scanner (one `getTransfers` call per transaction, which
 * fetches a receipt) exhausted a free-tier RPC's rate limit within minutes
 * against real Ethereum/BSC mainnet traffic. Any adapter WITHOUT those
 * methods (`FakeBlockchainAdapter`, and any future non-EVM adapter) falls
 * back to the original per-transaction `getTransfers` path, which is correct
 * for any `BlockchainAdapter` but only cheap enough for low-volume chains.
 *
 * KNOWN SIMPLIFICATION: reorg detection only re-verifies the single
 * last-processed block's hash each tick, not every block within
 * `reorgDepth`. A reorg deeper than one block still resolves correctly, just
 * over several ticks (each tick that finds a mismatch rewinds the cursor by
 * one more block) rather than in one pass.
 */
export interface ScanResult {
  network: Network;
  scannedBlocks: number;
  candidateTransactions: number;
  reorgDetected: boolean;
  chainTip: bigint;
  /** The cursor position this tick ends at (unchanged if nothing new was scanned). `chainTip - lastProcessedBlock` is how far behind the chain tip this network's monitor is - `main.ts` reports it as a metric. */
  lastProcessedBlock: bigint;
}

export interface MonitorServiceLike {
  processTransaction(adapter: BlockchainAdapter, network: Network, txHash: string): Promise<void>;
  updateConfirmations(adapter: BlockchainAdapter, network: Network): Promise<void>;
  handleReorg(network: Network, fromBlock: bigint): Promise<void>;
}

/** The cheap-discovery surface `EvmJsonRpcAdapter` offers beyond `BlockchainAdapter`. Detected by shape, not by class - any adapter exposing this gets the fast path. */
interface EvmDiscoveryAdapter {
  getLightBlock(numberOrHash: bigint | string): Promise<EvmLightBlock | null>;
  getTransferLogsTo(fromBlock: bigint, toBlock: bigint, contracts: readonly string[], toAddresses: readonly string[]): Promise<string[]>;
}

function asEvmDiscoveryAdapter(adapter: BlockchainAdapter): EvmDiscoveryAdapter | null {
  const candidate = adapter as Partial<EvmDiscoveryAdapter>;
  return typeof candidate.getLightBlock === 'function' && typeof candidate.getTransferLogsTo === 'function'
    ? (candidate as EvmDiscoveryAdapter)
    : null;
}

export class ChainScanner {
  constructor(
    private readonly db: DatabaseClient,
    private readonly adapter: BlockchainAdapter,
    private readonly monitor: MonitorServiceLike,
    private readonly network: Network,
    /** Upper bound on blocks scanned per tick, so one call cannot run unboundedly behind a fast chain. */
    private readonly blockBatchSize = 50,
  ) {}

  async tick(): Promise<ScanResult> {
    const current = await this.adapter.getCurrentBlock();
    let cursor = await this.loadCursor(current.number);

    const reorgDetected = await this.checkForReorg(cursor.lastProcessedBlock, cursor.lastProcessedHash);
    if (reorgDetected) {
      cursor = await this.rewindCursor(cursor.lastProcessedBlock);
    }

    const from = cursor.lastProcessedBlock + 1n;
    const to = current.number < from ? from - 1n : minBigInt(current.number, from + BigInt(this.blockBatchSize) - 1n);

    const trackedAddresses = await this.loadTrackedAddresses();
    const evmAdapter = asEvmDiscoveryAdapter(this.adapter);

    const { scannedBlocks, candidateTransactions, lastBlock } =
      evmAdapter && to >= from
        ? await this.scanRangeFast(evmAdapter, from, to, trackedAddresses)
        : await this.scanRangeGeneric(from, to, trackedAddresses);

    const endingBlock = lastBlock ? lastBlock.number : cursor.lastProcessedBlock;
    if (lastBlock) {
      await this.saveCursor(lastBlock.number, lastBlock.hash, current.number);
    } else {
      await this.saveCursor(cursor.lastProcessedBlock, cursor.lastProcessedHash, current.number);
    }

    await this.monitor.updateConfirmations(this.adapter, this.network);

    return {
      network: this.network,
      scannedBlocks,
      candidateTransactions,
      reorgDetected,
      chainTip: current.number,
      lastProcessedBlock: endingBlock,
    };
  }

  // ---------------------------------------------------------------------
  // Discovery: fast (EVM-specific) path
  // ---------------------------------------------------------------------

  private async scanRangeFast(
    evmAdapter: EvmDiscoveryAdapter,
    from: bigint,
    to: bigint,
    trackedAddresses: ReadonlySet<string>,
  ): Promise<{ scannedBlocks: number; candidateTransactions: number; lastBlock: { number: bigint; hash: string } | null }> {
    const candidateHashes = new Set<string>();
    let scannedBlocks = 0;
    let lastBlock: { number: bigint; hash: string } | null = null;

    for (let height = from; height <= to; height += 1n) {
      const block = await evmAdapter.getLightBlock(height);
      if (!block) break; // provider does not have it yet - stop, try again next tick
      for (const tx of block.transactions) {
        if (tx.to && tx.value > 0n && trackedAddresses.has(tx.to.toLowerCase())) candidateHashes.add(tx.hash);
      }
      lastBlock = { number: block.number, hash: block.hash };
      scannedBlocks += 1;
    }

    if (scannedBlocks > 0) {
      const contracts = listAssets({ network: this.network, enabledOnly: true })
        .map((asset) => asset.contractAddress)
        .filter((address): address is string => address !== null);
      const tokenHashes = await evmAdapter.getTransferLogsTo(from, from + BigInt(scannedBlocks) - 1n, contracts, [...trackedAddresses]);
      for (const hash of tokenHashes) candidateHashes.add(hash);
    }

    for (const hash of candidateHashes) {
      await this.monitor.processTransaction(this.adapter, this.network, hash);
    }

    return { scannedBlocks, candidateTransactions: candidateHashes.size, lastBlock };
  }

  // ---------------------------------------------------------------------
  // Discovery: generic (any BlockchainAdapter) fallback path
  // ---------------------------------------------------------------------

  private async scanRangeGeneric(
    from: bigint,
    to: bigint,
    trackedAddresses: ReadonlySet<string>,
  ): Promise<{ scannedBlocks: number; candidateTransactions: number; lastBlock: { number: bigint; hash: string } | null }> {
    let scannedBlocks = 0;
    let candidateTransactions = 0;
    let lastBlock: { number: bigint; hash: string } | null = null;

    for (let height = from; height <= to; height += 1n) {
      const block = await this.adapter.getBlock(height);
      if (!block) break;

      for (const tx of block.transactions) {
        if (await this.touchesTrackedAddress(tx.hash, trackedAddresses)) {
          candidateTransactions += 1;
          await this.monitor.processTransaction(this.adapter, this.network, tx.hash);
        }
      }

      lastBlock = { number: block.number, hash: block.hash };
      scannedBlocks += 1;
    }

    return { scannedBlocks, candidateTransactions, lastBlock };
  }

  private async touchesTrackedAddress(txHash: string, tracked: ReadonlySet<string>): Promise<boolean> {
    if (tracked.size === 0) return false;
    const transfers = await this.adapter.getTransfers(txHash);
    return transfers.some((transfer) => tracked.has(normalizeForTracking(transfer.toAddress)));
  }

  // ---------------------------------------------------------------------
  // Cursor / reorg bookkeeping
  // ---------------------------------------------------------------------

  private async loadTrackedAddresses(): Promise<Set<string>> {
    // ASSIGNED (live invoice) and RETIRED (closed, but late arrivals still need
    // to be recognised - see MonitorService.moveToLatePaymentReview) are worth
    // watching; AVAILABLE addresses have not been handed to anything yet.
    const rows = await this.db.paymentAddress.findMany({
      where: { network: this.network, status: { in: ['ASSIGNED', 'RETIRED'] } },
      select: { addressNormalized: true },
    });

    const tracked = new Set<string>();
    for (const row of rows) {
      const address = normalizeForTracking(row.addressNormalized);
      // A single malformed row (bad data, a migration bug, corruption) must
      // not take down monitoring for the WHOLE network - every tick would
      // fail forever, since `getTransferLogsTo` cannot encode an invalid
      // address into a log-topic filter. Skip it and keep going; it simply
      // will not be matched against, which is the correct behaviour for
      // something that cannot be a real on-chain address anyway.
      if (this.adapter.validateAddress(address)) tracked.add(address);
    }
    return tracked;
  }

  private async loadCursor(chainTip: bigint): Promise<{ lastProcessedBlock: bigint; lastProcessedHash: string | null }> {
    const existing = await this.db.chainCursor.findUnique({ where: { network: this.network } });
    if (existing) return { lastProcessedBlock: existing.lastProcessedBlock, lastProcessedHash: existing.lastProcessedHash };

    // First run for this network: start from the current tip rather than
    // genesis - this gateway only needs to observe payments from the moment
    // it starts watching, and scanning an entire chain's history is neither
    // necessary nor bounded.
    const start = chainTip > 0n ? chainTip - 1n : 0n;
    await this.db.chainCursor.create({
      data: { network: this.network, lastProcessedBlock: start, lastProcessedHash: null, chainTipBlock: chainTip },
    });
    return { lastProcessedBlock: start, lastProcessedHash: null };
  }

  /** Hash-only block lookup for reorg bookkeeping, using the cheap path when available. */
  private async getBlockHash(number: bigint): Promise<string | null> {
    const evmAdapter = asEvmDiscoveryAdapter(this.adapter);
    if (evmAdapter) return (await evmAdapter.getLightBlock(number))?.hash ?? null;
    return (await this.adapter.getBlock(number))?.hash ?? null;
  }

  private async checkForReorg(lastProcessedBlock: bigint, lastProcessedHash: string | null): Promise<boolean> {
    if (!lastProcessedHash || lastProcessedBlock <= 0n) return false;
    const hash = await this.getBlockHash(lastProcessedBlock);
    return hash === null || hash.toLowerCase() !== lastProcessedHash.toLowerCase();
  }

  private async rewindCursor(fromBlock: bigint): Promise<{ lastProcessedBlock: bigint; lastProcessedHash: string | null }> {
    await this.monitor.handleReorg(this.network, fromBlock);

    const rewound = fromBlock > 0n ? fromBlock - 1n : 0n;
    const previousHash = rewound > 0n ? await this.getBlockHash(rewound) : null;
    await this.db.chainCursor.update({
      where: { network: this.network },
      data: { lastProcessedBlock: rewound, lastProcessedHash: previousHash, lastReorgAt: new Date(), lastReorgDepth: 1 },
    });
    return { lastProcessedBlock: rewound, lastProcessedHash: previousHash };
  }

  private async saveCursor(block: bigint, hash: string | null, chainTip: bigint): Promise<void> {
    await this.db.chainCursor.update({
      where: { network: this.network },
      data: { lastProcessedBlock: block, lastProcessedHash: hash, chainTipBlock: chainTip },
    });
  }
}

function minBigInt(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

/**
 * EVM addresses are case-insensitive hex, and neither `PaymentAddress.addressNormalized`
 * nor a value fresh off an adapter is guaranteed lowercase (checksummed
 * mixed-case is common on the wire) - lowercasing both sides is what makes
 * them comparable. A Bitcoin address has no such case-insensitive form:
 * legacy Base58Check is case-SENSITIVE (lowercasing it changes which bytes
 * it decodes to, i.e. produces a different, generally invalid, address), and
 * bech32/bech32m is already normalized to lowercase wherever this codebase
 * produces or reads one. Gating on the "0x" prefix - which only an EVM
 * address ever has - keeps the EVM comparison working exactly as before
 * while leaving a Bitcoin address byte-for-byte as the chain itself uses it.
 */
function normalizeForTracking(address: string): string {
  return address.startsWith('0x') ? address.toLowerCase() : address;
}
