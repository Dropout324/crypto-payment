import { describe, expect, it } from 'vitest';
import {
  ZERO_ADDRESS,
  evmAddressesEqual,
  isStructurallyValidEvmAddress,
  isValidEvmAddress,
  normalizeEvmAddress,
  toChecksumAddress,
} from '../src/address/evm.js';

describe('structural validity', () => {
  it('accepts a well-formed 20-byte hex address', () => {
    expect(isStructurallyValidEvmAddress('0xdAC17F958D2ee523a2206206994597C13D831ec7'.slice(0, 42))).toBe(
      true,
    );
  });

  it.each([
    '',
    '0x',
    '0xdac17f958d2ee523a2206206994597c13d831e', // 39 hex chars
    '0xdac17f958d2ee523a2206206994597c13d831ec77', // 41 hex chars
    'dac17f958d2ee523a2206206994597c13d831ec7'.slice(0, 40), // missing 0x
    '0xZZZ17f958d2ee523a2206206994597c13d831ec',
  ])('rejects malformed address %j', (address) => {
    expect(isStructurallyValidEvmAddress(address)).toBe(false);
  });
});

describe('EIP-55 checksum (test vectors from the EIP)', () => {
  const vectors = [
    '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
    '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359',
    '0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB',
    '0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb',
  ];

  it.each(vectors)('reproduces the checksum for %s', (expected) => {
    expect(toChecksumAddress(expected.toLowerCase())).toBe(expected);
    expect(toChecksumAddress(expected.toUpperCase().replace('0X', '0x'))).toBe(expected);
  });

  it('accepts all-lowercase and all-uppercase as valid (unchecksummed)', () => {
    const vector = vectors[0] as string;
    expect(isValidEvmAddress(vector.toLowerCase())).toBe(true);
    expect(isValidEvmAddress(`0x${vector.slice(2).toUpperCase()}`)).toBe(true);
  });

  it('accepts a correctly checksummed mixed-case address', () => {
    expect(isValidEvmAddress(vectors[0] as string)).toBe(true);
  });

  it('rejects a mixed-case address with an incorrect checksum', () => {
    const vector = vectors[0] as string;
    // Flip the case of one character that the real checksum says should differ.
    const corrupted = vector.slice(0, -1) + (vector.at(-1) === vector.at(-1)?.toUpperCase()
      ? vector.at(-1)?.toLowerCase()
      : vector.at(-1)?.toUpperCase());
    expect(isValidEvmAddress(corrupted as string)).toBe(false);
  });

  it('catches a single-character typo that a naive hex check would miss', () => {
    // This is the entire point of EIP-55: a typo in a checksummed address is
    // detectable without touching the network.
    const vector = vectors[0] as string;
    const typoed = `0x6${vector.slice(3)}`; // change one hex digit
    expect(isStructurallyValidEvmAddress(typoed)).toBe(true); // still well-formed hex
    expect(isValidEvmAddress(typoed)).toBe(false); // but the checksum now fails
  });

  it('rejects structurally invalid input before computing a checksum', () => {
    expect(isValidEvmAddress('not-an-address')).toBe(false);
    expect(() => toChecksumAddress('not-an-address')).toThrow(/not a structurally valid/);
  });
});

describe('normalization and comparison', () => {
  it('normalizes to lowercase', () => {
    expect(normalizeEvmAddress('0xDAC17F958D2EE523A2206206994597C13D831EC7'.slice(0, 42))).toBe(
      '0xdac17f958d2ee523a2206206994597c13d831ec7'.slice(0, 42),
    );
  });

  it('treats checksummed and lowercase forms of the same address as equal', () => {
    expect(
      evmAddressesEqual(
        '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
        '0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed',
      ),
    ).toBe(true);
  });

  it('treats different addresses as different', () => {
    expect(evmAddressesEqual('0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed', ZERO_ADDRESS)).toBe(
      false,
    );
  });

  it('is false, not throwing, for malformed input', () => {
    expect(evmAddressesEqual('garbage', ZERO_ADDRESS)).toBe(false);
  });
});
