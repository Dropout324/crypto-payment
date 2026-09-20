import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { isValidBitcoinAddress, normalizeBitcoinAddress } from '../src/address/bitcoin.js';

/**
 * These tests deliberately do not lean on memorised address strings for the
 * exhaustive cases: they build addresses from scratch with an independent
 * encoder (Base58Check / Bech32 / Bech32m implemented locally, separate from
 * `src/address/bitcoin.ts`) so the assertions do not depend on correctly
 * recalling long strings by memory. A handful of famous, extremely
 * well-attested real-world addresses are included as an external sanity check.
 */

// --- Independent Base58Check encoder (test-only, mirrors nothing in src/) ---

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function sha256(data: Buffer): Buffer {
  return createHash('sha256').update(data).digest();
}

function base58Encode(bytes: Buffer): string {
  let value = BigInt(`0x${bytes.toString('hex') || '0'}`);
  let out = '';
  while (value > 0n) {
    const remainder = value % 58n;
    out = BASE58_ALPHABET[Number(remainder)] + out;
    value /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    out = `1${out}`;
  }
  return out || '1';
}

function encodeBase58Check(version: number, payload20: Buffer): string {
  const body = Buffer.concat([Buffer.from([version]), payload20]);
  const checksum = sha256(sha256(body)).subarray(0, 4);
  return base58Encode(Buffer.concat([body, checksum]));
}

// --- Independent Bech32 / Bech32m encoder (test-only) ---

const BECH32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

function bech32Polymod(values: number[]): number {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i += 1) if ((top >>> i) & 1) chk ^= GEN[i] as number;
  }
  return chk >>> 0;
}

function hrpExpand(hrp: string): number[] {
  const out: number[] = [];
  for (const c of hrp) out.push(c.charCodeAt(0) >>> 5);
  out.push(0);
  for (const c of hrp) out.push(c.charCodeAt(0) & 31);
  return out;
}

function convertBits(data: number[], from: number, to: number, pad: boolean): number[] {
  let acc = 0;
  let bits = 0;
  const out: number[] = [];
  const maxV = (1 << to) - 1;
  for (const v of data) {
    acc = (acc << from) | v;
    bits += from;
    while (bits >= to) {
      bits -= to;
      out.push((acc >>> bits) & maxV);
    }
  }
  if (pad && bits > 0) out.push((acc << (to - bits)) & maxV);
  return out;
}

function encodeSegwitAddress(hrp: string, version: number, program: number[]): string {
  const constVal = version === 0 ? 1 : 0x2bc830a3;
  const data = [version, ...convertBits(program, 8, 5, true)];
  const values = [...hrpExpand(hrp), ...data];
  const polymod = bech32Polymod([...values, 0, 0, 0, 0, 0, 0]) ^ constVal;
  const checksum: number[] = [];
  for (let i = 0; i < 6; i += 1) checksum.push((polymod >>> (5 * (5 - i))) & 31);
  const body = [...data, ...checksum].map((v) => BECH32_CHARSET[v]).join('');
  return `${hrp}1${body}`;
}

function samplePayload(byte: number, length: number): Buffer {
  return Buffer.from(Array.from({ length }, (_, i) => (byte + i) % 256));
}

// -----------------------------------------------------------------------------

describe('Base58Check (legacy P2PKH / P2SH)', () => {
  it('accepts a well-known real mainnet P2PKH address', () => {
    // Bitcoin's genesis coinbase address - among the most cited addresses in
    // existence.
    expect(isValidBitcoinAddress('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa', 'mainnet')).toBe(true);
  });

  it('accepts a self-encoded mainnet P2PKH address', () => {
    const address = encodeBase58Check(0x00, samplePayload(1, 20));
    expect(address.startsWith('1')).toBe(true);
    expect(isValidBitcoinAddress(address, 'mainnet')).toBe(true);
  });

  it('accepts a self-encoded mainnet P2SH address', () => {
    const address = encodeBase58Check(0x05, samplePayload(2, 20));
    expect(address.startsWith('3')).toBe(true);
    expect(isValidBitcoinAddress(address, 'mainnet')).toBe(true);
  });

  it('accepts a self-encoded testnet P2PKH address', () => {
    const address = encodeBase58Check(0x6f, samplePayload(3, 20));
    expect(isValidBitcoinAddress(address, 'testnet')).toBe(true);
    expect(isValidBitcoinAddress(address, 'mainnet')).toBe(false);
  });

  it('rejects a corrupted checksum', () => {
    const address = encodeBase58Check(0x00, samplePayload(4, 20));
    const corrupted = `${address.slice(0, -1)}${address.endsWith('1') ? '2' : '1'}`;
    expect(isValidBitcoinAddress(corrupted, 'mainnet')).toBe(false);
  });

  it('rejects a mainnet address presented as testnet and vice versa', () => {
    const mainnetAddress = encodeBase58Check(0x00, samplePayload(5, 20));
    expect(isValidBitcoinAddress(mainnetAddress, 'testnet')).toBe(false);
  });

  it('rejects an unknown version byte', () => {
    const address = encodeBase58Check(0x99, samplePayload(6, 20));
    expect(isValidBitcoinAddress(address, 'mainnet')).toBe(false);
  });

  it.each(['', '0OIl', 'not-base58!', '1'])('rejects malformed input %j', (input) => {
    expect(isValidBitcoinAddress(input, 'mainnet')).toBe(false);
  });
});

describe('Bech32 (native SegWit v0)', () => {
  it('accepts the well-known BIP-173 P2WPKH test vector', () => {
    expect(isValidBitcoinAddress('BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4', 'mainnet')).toBe(
      true,
    );
    expect(isValidBitcoinAddress('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', 'mainnet')).toBe(
      true,
    );
  });

  it('accepts a self-encoded v0 P2WPKH (20-byte program)', () => {
    const address = encodeSegwitAddress('bc', 0, Array.from(samplePayload(10, 20)));
    expect(isValidBitcoinAddress(address, 'mainnet')).toBe(true);
  });

  it('accepts a self-encoded v0 P2WSH (32-byte program)', () => {
    const address = encodeSegwitAddress('bc', 0, Array.from(samplePayload(20, 32)));
    expect(isValidBitcoinAddress(address, 'mainnet')).toBe(true);
  });

  it('rejects a v0 program of the wrong length', () => {
    const address = encodeSegwitAddress('bc', 0, Array.from(samplePayload(30, 21)));
    expect(isValidBitcoinAddress(address, 'mainnet')).toBe(false);
  });

  it('accepts the testnet human-readable prefix only under testnet', () => {
    const address = encodeSegwitAddress('tb', 0, Array.from(samplePayload(40, 20)));
    expect(isValidBitcoinAddress(address, 'testnet')).toBe(true);
    expect(isValidBitcoinAddress(address, 'mainnet')).toBe(false);
  });

  it('rejects mixed-case bech32 (BIP-173 forbids it)', () => {
    const address = encodeSegwitAddress('bc', 0, Array.from(samplePayload(50, 20)));
    const mixed = address.slice(0, 4) + address.slice(4).toUpperCase().slice(0, 3) + address.slice(7);
    expect(isValidBitcoinAddress(mixed, 'mainnet')).toBe(false);
  });

  it('rejects a corrupted checksum', () => {
    const address = encodeSegwitAddress('bc', 0, Array.from(samplePayload(60, 20)));
    const lastChar = address.at(-1) as string;
    const replacement = BECH32_CHARSET[(BECH32_CHARSET.indexOf(lastChar) + 1) % BECH32_CHARSET.length];
    const corrupted = address.slice(0, -1) + replacement;
    expect(isValidBitcoinAddress(corrupted, 'mainnet')).toBe(false);
  });
});

describe('Bech32m (Taproot, SegWit v1+)', () => {
  it('accepts a self-encoded v1 Taproot address (32-byte program)', () => {
    const address = encodeSegwitAddress('bc', 1, Array.from(samplePayload(70, 32)));
    expect(isValidBitcoinAddress(address, 'mainnet')).toBe(true);
  });

  it('rejects a v1+ program encoded with plain bech32 instead of bech32m', () => {
    // Pre-BIP-350 encoders (and the original BIP-173 examples) used bech32 for
    // every witness version; BIP-350 later required bech32m for v1+ so a typo
    // that used the wrong checksum constant is now correctly rejected.
    const constVal = 1; // bech32, not bech32m
    const version = 1;
    const program = Array.from(samplePayload(80, 32));
    const data = [version, ...convertBits(program, 8, 5, true)];
    const values = [...hrpExpand('bc'), ...data];
    const polymod = bech32Polymod([...values, 0, 0, 0, 0, 0, 0]) ^ constVal;
    const checksum: number[] = [];
    for (let i = 0; i < 6; i += 1) checksum.push((polymod >>> (5 * (5 - i))) & 31);
    const address = `bc1${[...data, ...checksum].map((v) => BECH32_CHARSET[v]).join('')}`;

    expect(isValidBitcoinAddress(address, 'mainnet')).toBe(false);
  });

  it('rejects a v0 program encoded with bech32m instead of bech32', () => {
    const version = 0;
    const program = Array.from(samplePayload(90, 20));
    const data = [version, ...convertBits(program, 8, 5, true)];
    const values = [...hrpExpand('bc'), ...data];
    const polymod = bech32Polymod([...values, 0, 0, 0, 0, 0, 0]) ^ 0x2bc830a3;
    const checksum: number[] = [];
    for (let i = 0; i < 6; i += 1) checksum.push((polymod >>> (5 * (5 - i))) & 31);
    const address = `bc1${[...data, ...checksum].map((v) => BECH32_CHARSET[v]).join('')}`;

    expect(isValidBitcoinAddress(address, 'mainnet')).toBe(false);
  });
});

describe('normalizeBitcoinAddress', () => {
  it('lowercases bech32 but preserves legacy case', () => {
    const bech32 = encodeSegwitAddress('bc', 0, Array.from(samplePayload(100, 20)));
    expect(normalizeBitcoinAddress(bech32.toUpperCase(), 'mainnet')).toBe(bech32.toLowerCase());

    const legacy = encodeBase58Check(0x00, samplePayload(110, 20));
    expect(normalizeBitcoinAddress(legacy, 'mainnet')).toBe(legacy);
  });

  it('throws for an invalid address rather than returning a best guess', () => {
    expect(() => normalizeBitcoinAddress('not-an-address', 'mainnet')).toThrow(/not a valid Bitcoin/);
  });
});
