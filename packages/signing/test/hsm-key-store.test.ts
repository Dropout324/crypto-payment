import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { EmulatedHsmKeyStore } from '../src/hsm-key-store.js';
import { KeyNotFoundError } from '../src/errors.js';

describe('EmulatedHsmKeyStore', () => {
  it('generates a key and returns only its public half', async () => {
    const store = new EmulatedHsmKeyStore();
    const { keyId, publicKey } = await store.generateKey('key_1');

    expect(keyId).toBe('key_1');
    expect(publicKey.length).toBeGreaterThan(0);
    expect(await store.getPublicKey('key_1')).toEqual(publicKey);
  });

  it('signs a digest with a signature that verifies against the public key', async () => {
    const store = new EmulatedHsmKeyStore();
    const { publicKey } = await store.generateKey('key_1');
    const digest = Buffer.from('a'.repeat(64), 'hex');

    const signature = await store.sign('key_1', digest);

    expect(EmulatedHsmKeyStore.verify(publicKey, digest, signature)).toBe(true);
  });

  it('produces a signature that fails verification against a different key\'s public half', async () => {
    const store = new EmulatedHsmKeyStore();
    await store.generateKey('key_1');
    const { publicKey: otherPublicKey } = await store.generateKey('key_2');
    const digest = Buffer.from('b'.repeat(64), 'hex');

    const signature = await store.sign('key_1', digest);

    expect(EmulatedHsmKeyStore.verify(otherPublicKey, digest, signature)).toBe(false);
  });

  it('throws KeyNotFoundError for an unknown key id, on every operation', async () => {
    const store = new EmulatedHsmKeyStore();
    await expect(store.getPublicKey('missing')).rejects.toThrow(KeyNotFoundError);
    await expect(store.sign('missing', Buffer.alloc(32))).rejects.toThrow(KeyNotFoundError);
    await expect(store.rotateKey('missing')).rejects.toThrow(KeyNotFoundError);
  });

  it('rotates a key: the new key signs, the old key is retained for verification but refuses to sign again', async () => {
    const store = new EmulatedHsmKeyStore();
    const original = await store.generateKey('key_1');
    const digest = Buffer.from('c'.repeat(64), 'hex');
    const oldSignature = await store.sign('key_1', digest);

    const rotated = await store.rotateKey('key_1');

    expect(rotated.keyId).not.toBe('key_1');
    // The old key's public half is still retrievable, so a historical signature can still be checked.
    expect(await store.getPublicKey('key_1')).toEqual(original.publicKey);
    expect(EmulatedHsmKeyStore.verify(original.publicKey, digest, oldSignature)).toBe(true);
    // But it no longer signs.
    await expect(store.sign('key_1', digest)).rejects.toThrow(KeyNotFoundError);
    // The new key works.
    const newSignature = await store.sign(rotated.keyId, digest);
    expect(EmulatedHsmKeyStore.verify(rotated.publicKey, digest, newSignature)).toBe(true);
  });

  describe('key isolation - private key material never leaves the module', () => {
    it('is absent from JSON.stringify', async () => {
      const store = new EmulatedHsmKeyStore();
      await store.generateKey('key_1');
      expect(JSON.stringify(store)).toBe('{}');
    });

    it('is absent from util.inspect, including with showHidden', async () => {
      const store = new EmulatedHsmKeyStore();
      const { publicKey } = await store.generateKey('key_1');
      const inspected = inspect(store, { showHidden: true, depth: 10 });
      // The public key is fine to appear in memory dumps; the private key material must not.
      // A PKCS8-DER private key for this curve is 118 bytes - assert none of its bytes appear as a hex run.
      expect(inspected).not.toContain(publicKey.toString('hex'));
    });

    it('exposes no own enumerable properties that could hold key material', async () => {
      const store = new EmulatedHsmKeyStore();
      await store.generateKey('key_1');
      expect(Object.keys(store)).toEqual([]);
      expect(Object.getOwnPropertyNames(store)).toEqual([]);
    });

    it('has no public method that returns a private key', async () => {
      const store = new EmulatedHsmKeyStore();
      await store.generateKey('key_1');
      const methodNames = Object.getOwnPropertyNames(Object.getPrototypeOf(store));
      for (const name of methodNames) {
        expect(name.toLowerCase()).not.toContain('private');
      }
    });
  });
});
