import { createHash } from 'node:crypto';

/**
 * Bitcoin address validation.
 *
 * Covers all three address families in production use:
 *  - Base58Check legacy (P2PKH, prefix "1") and P2SH (prefix "3")
 *  - Bech32 native SegWit v0, P2WPKH/P2WSH (prefix "bc1q")
 *  - Bech32m SegWit v1+, Taproot P2TR (prefix "bc1p")
 *
 * Structural + checksum validation only, as required by the adapter interface
 * - this proves the address is well-formed, not that it has ever been used.
 */

export type BitcoinNetworkKind = 'mainnet' | 'testnet';

function sha256(data: Buffer): Buffer {
  return createHash('sha256').update(data).digest();
}

function doubleSha256(data: Buffer): Buffer {
  return sha256(sha256(data));
}

// ---------------------------------------------------------------------------
// Base58Check (legacy P2PKH / P2SH)
// ---------------------------------------------------------------------------

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BASE58_MAP = new Map(Array.from(BASE58_ALPHABET).map((char, index) => [char, index]));

function base58Decode(input: string): Buffer | null {
  if (input.length === 0) return null;

  let value = 0n;
  for (const char of input) {
    const digit = BASE58_MAP.get(char);
    if (digit === undefined) return null;
    value = value * 58n + BigInt(digit);
  }

  let hex = value.toString(16);
  if (hex.length % 2 !== 0) hex = `0${hex}`;
  const bytes = hex === '0' ? Buffer.alloc(0) : Buffer.from(hex, 'hex');

  // Each leading '1' encodes one leading zero byte in the original data.
  let leadingZeros = 0;
  for (const char of input) {
    if (char !== '1') break;
    leadingZeros += 1;
  }

  return Buffer.concat([Buffer.alloc(leadingZeros, 0), bytes]);
}

const LEGACY_MAINNET_VERSIONS = new Set([0x00, 0x05]); // P2PKH, P2SH
const LEGACY_TESTNET_VERSIONS = new Set([0x6f, 0xc4]); // P2PKH, P2SH

function isValidBase58Check(address: string, network: BitcoinNetworkKind): boolean {
  const decoded = base58Decode(address);
  if (!decoded || decoded.length !== 25) return false;

  const payload = decoded.subarray(0, 21);
  const checksum = decoded.subarray(21);
  const expected = doubleSha256(payload).subarray(0, 4);
  if (!checksum.equals(expected)) return false;

  const version = payload[0] as number;
  return network === 'mainnet'
    ? LEGACY_MAINNET_VERSIONS.has(version)
    : LEGACY_TESTNET_VERSIONS.has(version);
}

// ---------------------------------------------------------------------------
// Bech32 / Bech32m (SegWit)
// ---------------------------------------------------------------------------

const BECH32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const BECH32_CONST = 1;
const BECH32M_CONST = 0x2bc830a3;

function bech32Polymod(values: number[]): number {
  const GENERATORS = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let checksum = 1;
  for (const value of values) {
    const top = checksum >>> 25;
    checksum = ((checksum & 0x1ffffff) << 5) ^ value;
    for (let i = 0; i < 5; i += 1) {
      if ((top >>> i) & 1) checksum ^= GENERATORS[i] as number;
    }
  }
  return checksum >>> 0;
}

function bech32HrpExpand(hrp: string): number[] {
  const result: number[] = [];
  for (const char of hrp) result.push(char.charCodeAt(0) >>> 5);
  result.push(0);
  for (const char of hrp) result.push(char.charCodeAt(0) & 31);
  return result;
}

interface Bech32Decoded {
  hrp: string;
  version: number;
  program: number[];
  variant: 'bech32' | 'bech32m';
}

function bech32Decode(address: string): Bech32Decoded | null {
  if (address.length < 8 || address.length > 90) return null;
  if (address !== address.toLowerCase() && address !== address.toUpperCase()) return null;

  const lower = address.toLowerCase();
  const separator = lower.lastIndexOf('1');
  if (separator < 1 || separator + 7 > lower.length) return null;

  const hrp = lower.slice(0, separator);
  const dataPart = lower.slice(separator + 1);

  const values: number[] = [];
  for (const char of dataPart) {
    const index = BECH32_CHARSET.indexOf(char);
    if (index === -1) return null;
    values.push(index);
  }

  const checksumValue = bech32Polymod([...bech32HrpExpand(hrp), ...values]);
  const variant: 'bech32' | 'bech32m' | null =
    checksumValue === BECH32_CONST ? 'bech32' : checksumValue === BECH32M_CONST ? 'bech32m' : null;
  if (!variant) return null;

  const witnessValues = values.slice(0, -6);
  if (witnessValues.length === 0) return null;

  const version = witnessValues[0] as number;
  const programWords = witnessValues.slice(1);

  const program = convertBits(programWords, 5, 8, false);
  if (!program) return null;

  // BIP-173/350 length rules.
  if (program.length < 2 || program.length > 40) return null;
  if (version === 0 && program.length !== 20 && program.length !== 32) return null;
  // Version 0 must use bech32; version 1+ (Taproot) must use bech32m.
  if (version === 0 && variant !== 'bech32') return null;
  if (version !== 0 && variant !== 'bech32m') return null;

  return { hrp, version, program, variant };
}

function convertBits(data: number[], fromBits: number, toBits: number, pad: boolean): number[] | null {
  let acc = 0;
  let bits = 0;
  const result: number[] = [];
  const maxValue = (1 << toBits) - 1;

  for (const value of data) {
    if (value < 0 || value >>> fromBits !== 0) return null;
    acc = (acc << fromBits) | value;
    bits += fromBits;
    while (bits >= toBits) {
      bits -= toBits;
      result.push((acc >>> bits) & maxValue);
    }
  }

  if (pad) {
    if (bits > 0) result.push((acc << (toBits - bits)) & maxValue);
  } else if (bits >= fromBits || ((acc << (toBits - bits)) & maxValue) !== 0) {
    return null;
  }

  return result;
}

function isValidSegwit(address: string, network: BitcoinNetworkKind): boolean {
  const decoded = bech32Decode(address);
  if (!decoded) return false;
  return decoded.hrp === (network === 'mainnet' ? 'bc' : 'tb');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function isValidBitcoinAddress(
  address: string,
  network: BitcoinNetworkKind = 'mainnet',
): boolean {
  if (typeof address !== 'string' || address.length === 0) return false;
  return isValidBase58Check(address, network) || isValidSegwit(address, network);
}

/**
 * Canonical form: legacy/P2SH (Base58Check) addresses are case-sensitive and
 * kept exactly as given; bech32/bech32m addresses are lowercased per
 * BIP-173. Which family `address` belongs to is decided by re-running the
 * same Base58Check check `isValidBitcoinAddress` uses, not by guessing from
 * its leading character - a prefix-based guess undercounts (e.g. testnet
 * legacy P2PKH addresses start with "m"/"n", not "1"/"3"/"2") and would
 * silently lowercase a case-sensitive address into a different, generally
 * invalid one.
 */
export function normalizeBitcoinAddress(address: string, network: BitcoinNetworkKind = 'mainnet'): string {
  if (!isValidBitcoinAddress(address, network)) {
    throw new Error(`not a valid Bitcoin ${network} address: ${address}`);
  }
  return isValidBase58Check(address, network) ? address : address.toLowerCase();
}
