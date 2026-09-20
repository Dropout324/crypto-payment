import { normalizeEvmAddress } from '../address/evm.js';
import type { ParsedTransfer } from '../adapter.js';

/**
 * ERC-20 / BEP-20 `Transfer(address indexed from, address indexed to, uint256 value)`
 * log parsing.
 *
 * keccak256("Transfer(address,address,uint256)") - the standard's fixed topic0.
 * Any log with this topic is claiming to be a Transfer event; the caller is
 * responsible for checking `log.address` against the allowlisted contract
 * before trusting the claim (SPEC section 4: match on contract address).
 */
export const TRANSFER_EVENT_TOPIC =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

export interface RawEvmLog {
  /** Contract that emitted the log. */
  address: string;
  topics: string[];
  /** Hex-encoded, 0x-prefixed. */
  data: string;
  /** Position of this log within the transaction's receipt. */
  logIndex: number;
}

export class TransferLogParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransferLogParseError';
  }
}

function stripHexPrefix(value: string): string {
  return value.startsWith('0x') || value.startsWith('0X') ? value.slice(2) : value;
}

/** Inverse of `addressFromTopic` - left-pad an address to a 32-byte topic, for building `eth_getLogs` filters. */
export function addressToTopic(address: string): string {
  return `0x${'0'.repeat(24)}${normalizeEvmAddress(address).slice(2)}`;
}

/** A 32-byte topic encoding an address has 24 bytes of zero padding first. */
function addressFromTopic(topic: string): string {
  const hex = stripHexPrefix(topic);
  if (hex.length !== 64) {
    throw new TransferLogParseError(`topic is not 32 bytes: ${topic}`);
  }
  const padding = hex.slice(0, 24);
  if (!/^0{24}$/.test(padding)) {
    throw new TransferLogParseError(`topic has non-zero padding, not an address: ${topic}`);
  }
  return normalizeEvmAddress(`0x${hex.slice(24)}`);
}

function amountFromData(data: string): bigint {
  const hex = stripHexPrefix(data);
  if (hex.length === 0) throw new TransferLogParseError('empty log data');
  if (hex.length > 64 || !/^[0-9a-fA-F]+$/.test(hex)) {
    throw new TransferLogParseError(`malformed uint256 data: ${data}`);
  }
  return BigInt(`0x${hex}`);
}

/**
 * Parse one log into a transfer, or `null` if it is not a standard Transfer
 * event (wrong topic count, non-Transfer topic0, or malformed encoding).
 * Malformed logs are skipped rather than thrown on: a contract emitting
 * garbage must not crash the monitor for every other transaction in the block.
 */
export function parseTransferLog(log: RawEvmLog): ParsedTransfer | null {
  if (log.topics.length !== 3) return null;
  if (log.topics[0]?.toLowerCase() !== TRANSFER_EVENT_TOPIC) return null;

  try {
    const fromAddress = addressFromTopic(log.topics[1] as string);
    const toAddress = addressFromTopic(log.topics[2] as string);
    const amount = amountFromData(log.data);

    // A zero-value transfer is valid per the standard but carries no funds;
    // the monitor should not credit it, so it is filtered out here.
    if (amount === 0n) return null;

    return {
      transferIndex: log.logIndex,
      tokenContract: normalizeEvmAddress(log.address),
      fromAddress,
      toAddress,
      amount,
    };
  } catch (error) {
    if (error instanceof TransferLogParseError) return null;
    throw error;
  }
}

/** Parse every Transfer event out of a transaction receipt's logs. */
export function parseTransferLogs(logs: readonly RawEvmLog[]): ParsedTransfer[] {
  const transfers: ParsedTransfer[] = [];
  for (const log of logs) {
    const transfer = parseTransferLog(log);
    if (transfer) transfers.push(transfer);
  }
  return transfers;
}

/**
 * A native-coin (ETH/BNB/POL) transfer, expressed with the same `ParsedTransfer`
 * shape as a token log so callers can treat them uniformly. Convention:
 * `transferIndex = -1` for the native transfer, since it has no log index -
 * this keeps it out of the way of real log indices, which are always >= 0.
 */
export function nativeTransfer(params: {
  fromAddress: string | null;
  toAddress: string;
  value: bigint;
}): ParsedTransfer | null {
  if (params.value <= 0n) return null;
  return {
    transferIndex: -1,
    tokenContract: null,
    fromAddress: params.fromAddress ? normalizeEvmAddress(params.fromAddress) : null,
    toAddress: normalizeEvmAddress(params.toAddress),
    amount: params.value,
  };
}
