import { createPrivateKey, createPublicKey, generateKeyPairSync, sign as ecSign, verify as ecVerify } from 'node:crypto';
import { KeyNotFoundError } from './errors.js';

/**
 * The key-management seam a real KMS/HSM integration implements - separate
 * from `SigningBackend` (which is the *transaction*-signing seam) because a
 * production KMS exposes key lifecycle (generate, rotate, get public key)
 * and raw-digest signing as its own API surface, independent of any
 * particular chain's transaction format. This mirrors AWS KMS's asymmetric
 * `ECC_SECG_P256K1` key spec and `Sign`/`GetPublicKey` operations, GCP KMS's
 * `EC_SIGN_SECP256K1_SHA256`, and a PKCS#11 HSM's `C_GenerateKeyPair`/`C_Sign`
 * - a real adapter for any of them implements this same shape.
 *
 * Every method takes and returns a `keyId` (an opaque handle) or a public
 * key - never a private key. That is the entire point of the interface: it
 * is impossible to express "give me the private key" through it.
 */
export interface HsmKeyStore {
  /** Generates a new secp256k1 key pair inside the module and returns its handle and public key. Never returns the private key. */
  generateKey(keyId: string): Promise<{ keyId: string; publicKey: Buffer }>;
  getPublicKey(keyId: string): Promise<Buffer>;
  /** Signs a pre-computed digest (never raw, unhashed data - callers hash first) and returns a DER-encoded ECDSA signature. */
  sign(keyId: string, digest: Buffer): Promise<Buffer>;
  /**
   * Generates a new physical key for the same logical purpose and returns
   * its handle. The old key is retained (its public key stays retrievable,
   * so signatures it already produced can still be verified) but this store
   * never signs with it again - see ADR 0026 for the rotation strategy this
   * implements.
   */
  rotateKey(oldKeyId: string): Promise<{ keyId: string; publicKey: Buffer }>;
}

interface StoredKey {
  privateKeyDer: Buffer;
  publicKey: Buffer;
  /** Rotated-out keys are kept for `getPublicKey()` (verifying old signatures) but `sign()` refuses them. */
  retired: boolean;
}

/**
 * The only `HsmKeyStore` shipped here - a software emulation of an HSM's
 * key isolation, not a real one. Explicitly labelled *simulated*: see
 * `EmulatedHsmSigningBackend`'s own doc comment and ADR 0026 for exactly
 * what this does and does not prove.
 *
 * Private key material lives only in a private class field
 * (`#keys`, a true JS private field - not merely TypeScript `private`, which
 * is erased at compile time and would still be reachable via bracket
 * notation or `JSON.stringify`). No method, including error paths, ever
 * returns, logs, or serializes it. `packages/signing/test/hsm-key-store.test.ts`
 * asserts this directly: `JSON.stringify`, `util.inspect` with
 * `showHidden: true`, and `Object.getOwnPropertyNames` on a live store never
 * surface key bytes.
 */
export class EmulatedHsmKeyStore implements HsmKeyStore {
  #keys = new Map<string, StoredKey>();

  async generateKey(keyId: string): Promise<{ keyId: string; publicKey: Buffer }> {
    const { privateKey, publicKey } = generateKeyPairSync('ec', {
      namedCurve: 'secp256k1',
      privateKeyEncoding: { type: 'pkcs8', format: 'der' },
      publicKeyEncoding: { type: 'spki', format: 'der' },
    });
    this.#keys.set(keyId, { privateKeyDer: privateKey, publicKey, retired: false });
    return { keyId, publicKey };
  }

  async getPublicKey(keyId: string): Promise<Buffer> {
    const entry = this.#keys.get(keyId);
    if (!entry) throw new KeyNotFoundError(keyId);
    return entry.publicKey;
  }

  async sign(keyId: string, digest: Buffer): Promise<Buffer> {
    const entry = this.#keys.get(keyId);
    if (!entry) throw new KeyNotFoundError(keyId);
    if (entry.retired) throw new KeyNotFoundError(`${keyId} (rotated out - no longer used for signing)`);

    const privateKey = createPrivateKey({ key: entry.privateKeyDer, format: 'der', type: 'pkcs8' });
    // `dsaEncoding: 'der'` matches what AWS KMS/GCP KMS return for an ECDSA
    // signature - keeps a future real backend's output shape identical to
    // this emulated one.
    return ecSign(null, digest, { key: privateKey, dsaEncoding: 'der' });
  }

  async rotateKey(oldKeyId: string): Promise<{ keyId: string; publicKey: Buffer }> {
    const old = this.#keys.get(oldKeyId);
    if (!old) throw new KeyNotFoundError(oldKeyId);
    old.retired = true;

    const newKeyId = `${oldKeyId}.r${Date.now()}`;
    return this.generateKey(newKeyId);
  }

  /** Verification helper for tests - takes only public material, so it cannot be used to leak a private key. */
  static verify(publicKey: Buffer, digest: Buffer, signature: Buffer): boolean {
    return ecVerify(null, digest, { key: createPublicKey({ key: publicKey, format: 'der', type: 'spki' }), dsaEncoding: 'der' }, signature);
  }
}
