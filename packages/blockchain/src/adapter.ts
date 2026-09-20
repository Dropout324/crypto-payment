import type { NetworkValue } from '@gateway/shared';

/**
 * BlockchainAdapter (SPEC section 4).
 *
 * Every chain the gateway supports implements this interface. The payment
 * service, the monitor and the confirmation engine talk to adapters only
 * through this contract - no chain-specific branching lives outside
 * `packages/blockchain/src/adapters/*`.
 *
 * Design rules that make this interface hold up in practice:
 *
 *  - Every amount crossing the boundary is a `bigint` of smallest units.
 *    Nothing here returns a `number` for a value that represents money.
 *  - `getTransaction` and `getBlock` return `null` for "not found", and throw
 *    only for a transport/provider failure. A caller must be able to tell "the
 *    chain does not have this" apart from "I could not ask the chain".
 *  - Nothing in this interface promises finality. `getConfirmations` reports
 *    a count; the caller (the confirmation engine) decides what count is safe.
 *  - `monitorTransactions` is push-based (new data arrives via callback) but
 *    every implementation MUST be safe to poll instead: WebSocket adapters
 *    still need a reconciliation pass, because SPEC section 9 forbids treating
 *    a stream event as proof of anything.
 */

// ---------------------------------------------------------------------------
// Shared value types
// ---------------------------------------------------------------------------

export interface BlockRef {
  number: bigint;
  hash: string;
  parentHash: string;
  timestamp: Date;
}

export type ChainTransactionStatus = 'PENDING' | 'SUCCESS' | 'REVERTED';

export interface ChainTransaction {
  hash: string;
  /** Null while the transaction sits in the mempool. */
  blockNumber: bigint | null;
  blockHash: string | null;
  /** Index of this transaction within its block; null while unmined. */
  transactionIndex: number | null;
  status: ChainTransactionStatus;
  fromAddress: string | null;
  toAddress: string | null;
  /** Native-coin value moved by the transaction itself, in smallest units. */
  value: bigint;
  /** Network fee actually paid, in the chain's native smallest units. */
  feeAmount: bigint | null;
  /** Confirmations at the moment this was fetched - a snapshot, not a promise. */
  confirmations: number;
  /** Raw provider payload, kept for forensics. Never used for credit decisions. */
  raw: unknown;
}

/**
 * One value movement extracted from a transaction: a native-coin transfer or
 * one ERC-20/BEP-20 Transfer log. EVM: `transferIndex` is the log index.
 * Bitcoin: it is the output (vout) index. This pairing is what
 * `packages/database`'s `token_transfers.(network, tx_hash, transfer_index)`
 * constraint keys on, so adapters must be consistent between calls.
 */
export interface ParsedTransfer {
  transferIndex: number;
  /** Null for a native-coin transfer. */
  tokenContract: string | null;
  fromAddress: string | null;
  toAddress: string;
  /** Smallest units, exactly as read from the chain - no rounding, no rebasing applied. */
  amount: bigint;
}

export interface BlockData extends BlockRef {
  transactions: ChainTransaction[];
}

export interface ConfirmationInfo {
  confirmations: number;
  blockNumber: bigint | null;
  chainTip: bigint;
}

/** True/false only for well-formed input; malformed input is also `false`, never a throw. */
export type AddressValidator = (address: string) => boolean;

export interface MonitorEvent {
  type: 'block' | 'transaction' | 'reorg';
  network: NetworkValue;
}

export interface BlockEvent extends MonitorEvent {
  type: 'block';
  block: BlockRef;
}

export interface TransactionEvent extends MonitorEvent {
  type: 'transaction';
  transaction: ChainTransaction;
}

export interface ReorgEvent extends MonitorEvent {
  type: 'reorg';
  /** Height of the earliest block known to have changed. */
  fromBlock: bigint;
  newTip: bigint;
}

export type AnyMonitorEvent = BlockEvent | TransactionEvent | ReorgEvent;

export interface MonitorHandle {
  /** Stop the subscription and release the underlying connection. */
  stop: () => Promise<void>;
}

export interface MonitorOptions {
  /** Resume from this height rather than the current tip. */
  fromBlock?: bigint;
  onEvent: (event: AnyMonitorEvent) => void;
  onError: (error: Error) => void;
}

/**
 * Thrown by adapter methods for transport/provider failures - a timeout, a
 * malformed response, a rate limit. Never thrown for "not found"; that is a
 * `null` return.
 */
export class BlockchainAdapterError extends Error {
  readonly network: NetworkValue;
  readonly retryable: boolean;

  constructor(network: NetworkValue, message: string, options: { retryable?: boolean; cause?: unknown } = {}) {
    super(message);
    this.name = 'BlockchainAdapterError';
    this.network = network;
    this.retryable = options.retryable ?? true;
    this.cause = options.cause;
  }
}

// ---------------------------------------------------------------------------
// The interface
// ---------------------------------------------------------------------------

export interface BlockchainAdapter {
  readonly network: NetworkValue;

  /**
   * Native-coin balance of `address`, in smallest units. Token balances are
   * intentionally out of scope: the gateway credits from observed TRANSFERS,
   * never from a balance snapshot, so a balance check cannot substitute for
   * transaction verification.
   */
  getBalance(address: string): Promise<bigint>;

  /** `null` when the hash is unknown to this node/provider. */
  getTransaction(hash: string): Promise<ChainTransaction | null>;

  /**
   * Parse every value-moving event out of a transaction: native transfer plus
   * any allowlisted-token Transfer logs / outputs. Returns an empty array for
   * a transaction that moves nothing relevant (e.g. a bare contract call).
   */
  getTransfers(hash: string): Promise<ParsedTransfer[]>;

  getBlock(numberOrHash: bigint | string): Promise<BlockData | null>;

  getCurrentBlock(): Promise<BlockRef>;

  /**
   * Confirmations for a specific transaction right now. Returns
   * `confirmations: 0` for a transaction that is not yet mined, never throws
   * for that case.
   */
  getConfirmations(hash: string): Promise<ConfirmationInfo>;

  /** Structural validity only - this is NOT a check that the address exists or has ever been used. */
  validateAddress: AddressValidator;

  /**
   * Subscribe to new activity. Implementations should treat this purely as an
   * early signal: every event must still be re-verified via `getTransaction`
   * before anything is credited (SPEC section 9 - never trust a stream event
   * blindly). Returns a handle to stop the subscription.
   */
  monitorTransactions(options: MonitorOptions): Promise<MonitorHandle>;
}

/** Narrow a partial mock/stub down to the interface shape at compile time. */
export function isBlockchainAdapter(value: unknown): value is BlockchainAdapter {
  if (typeof value !== 'object' || value === null) return false;
  const required = [
    'network',
    'getBalance',
    'getTransaction',
    'getTransfers',
    'getBlock',
    'getCurrentBlock',
    'getConfirmations',
    'validateAddress',
    'monitorTransactions',
  ] as const;
  return required.every((key) => key in (value as Record<string, unknown>));
}
