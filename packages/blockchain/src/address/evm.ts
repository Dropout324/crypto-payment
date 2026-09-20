import { keccak_256 } from '@noble/hashes/sha3';

/**
 * EVM address validation and normalisation.
 *
 * Structural validity only (SPEC section 4: `validateAddress`) - this does not
 * check the address has ever been used, and it deliberately accepts the
 * all-zero and burn addresses, which are structurally valid destinations.
 */

const HEX_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export function isStructurallyValidEvmAddress(address: string): boolean {
  return typeof address === 'string' && HEX_ADDRESS.test(address);
}

/**
 * EIP-55 checksum encoding: mixed-case hex where each hex digit's case
 * encodes a checksum bit derived from the keccak256 hash of the lowercase
 * address. A wallet that gets this wrong sends funds to a typo'd address with
 * no on-chain error - this is the guard against exactly that class of mistake.
 */
export function toChecksumAddress(address: string): string {
  if (!isStructurallyValidEvmAddress(address)) {
    throw new Error(`not a structurally valid EVM address: ${address}`);
  }

  const lower = address.slice(2).toLowerCase();
  const hashHex = Buffer.from(keccak_256(lower)).toString('hex');

  let checksummed = '0x';
  for (let i = 0; i < lower.length; i += 1) {
    const char = lower[i] as string;
    // Uppercase the hex digit when the corresponding nibble of the hash is >= 8.
    checksummed += parseInt(hashHex[i] as string, 16) >= 8 ? char.toUpperCase() : char;
  }
  return checksummed;
}

/**
 * True when `address` is either all-lowercase/all-uppercase (unchecksummed -
 * accepted, since not every source checksums) or correctly EIP-55 checksummed.
 * False for a MIXED-case address whose checksum does not match: that is the
 * one shape that indicates a corrupted address, not just an unchecksummed one.
 */
export function isValidEvmAddress(address: string): boolean {
  if (!isStructurallyValidEvmAddress(address)) return false;

  const body = address.slice(2);
  const isAllOneCase = body === body.toLowerCase() || body === body.toUpperCase();
  if (isAllOneCase) return true;

  return toChecksumAddress(address) === address;
}

/** Canonical form used for all storage and comparison: lowercase. */
export function normalizeEvmAddress(address: string): string {
  if (!isStructurallyValidEvmAddress(address)) {
    throw new Error(`not a structurally valid EVM address: ${address}`);
  }
  return address.toLowerCase();
}

export function evmAddressesEqual(a: string, b: string): boolean {
  return isStructurallyValidEvmAddress(a) && isStructurallyValidEvmAddress(b) && a.toLowerCase() === b.toLowerCase();
}

/** The conventional null/burn address. Structurally valid, but never a real destination. */
export const ZERO_ADDRESS = `0x${'0'.repeat(40)}`;
