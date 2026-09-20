import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Application-layer encryption for secrets that must be RECOVERABLE:
 * webhook signing secrets (we recompute HMACs with them) and TOTP seeds.
 *
 * Anything that only needs to be CHECKED - passwords, API key secrets - is
 * hashed instead and never lands here.
 *
 * AES-256-GCM with a random 96-bit IV per message. The stored ciphertext is
 * self-describing so keys can be rotated without a migration:
 *
 *   v1.<keyId>.<iv base64url>.<authTag base64url>.<ciphertext base64url>
 *
 * PRODUCTION NOTE: the key belongs in a KMS/HSM, and this module should call
 * out to it rather than hold key bytes in process memory. The env-var path
 * below is the development fallback; `KeyProvider` is the seam where a KMS
 * implementation plugs in.
 */

const FORMAT_VERSION = 'v1';
const IV_BYTES = 12;
const KEY_BYTES = 32;
const AUTH_TAG_BYTES = 16;

export class EncryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EncryptionError';
  }
}

export interface KeyProvider {
  /** Key used for new ciphertext. */
  currentKeyId(): string;
  /** Resolve a key by id so old ciphertext stays readable after rotation. */
  getKey(keyId: string): Buffer;
}

/** Development / single-key provider driven by environment variables. */
export class EnvKeyProvider implements KeyProvider {
  private readonly keys: Map<string, Buffer>;
  private readonly activeKeyId: string;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    const rawKey = env.ENCRYPTION_KEY;
    const keyId = env.ENCRYPTION_KEY_ID;

    if (!rawKey || !keyId) {
      throw new EncryptionError('ENCRYPTION_KEY and ENCRYPTION_KEY_ID must be set');
    }

    const key = Buffer.from(rawKey, 'base64');
    if (key.length !== KEY_BYTES) {
      throw new EncryptionError(
        `ENCRYPTION_KEY must decode to ${KEY_BYTES} bytes, got ${key.length}`,
      );
    }

    this.keys = new Map([[keyId, key]]);
    this.activeKeyId = keyId;

    // Retired keys stay loadable so existing rows can still be decrypted:
    // ENCRYPTION_KEY_RETIRED=<id>:<base64>,<id>:<base64>
    const retired = env.ENCRYPTION_KEY_RETIRED;
    if (retired) {
      for (const entry of retired.split(',')) {
        const [id, material] = entry.split(':');
        if (!id || !material) continue;
        const retiredKey = Buffer.from(material, 'base64');
        if (retiredKey.length !== KEY_BYTES) {
          throw new EncryptionError(`retired key ${id} has the wrong length`);
        }
        this.keys.set(id, retiredKey);
      }
    }
  }

  currentKeyId(): string {
    return this.activeKeyId;
  }

  getKey(keyId: string): Buffer {
    const key = this.keys.get(keyId);
    if (!key) throw new EncryptionError(`unknown encryption key id: ${keyId}`);
    return key;
  }
}

export function encryptSecret(plaintext: string, provider: KeyProvider): string {
  if (typeof plaintext !== 'string' || plaintext.length === 0) {
    throw new EncryptionError('cannot encrypt an empty value');
  }

  const keyId = provider.currentKeyId();
  const key = provider.getKey(keyId);
  const iv = randomBytes(IV_BYTES);

  const cipher = createCipheriv('aes-256-gcm', key, iv);
  // Bind the ciphertext to its header, so a key id cannot be swapped by an
  // attacker with database write access without failing authentication.
  cipher.setAAD(Buffer.from(`${FORMAT_VERSION}.${keyId}`, 'utf8'));

  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return [
    FORMAT_VERSION,
    keyId,
    iv.toString('base64url'),
    authTag.toString('base64url'),
    ciphertext.toString('base64url'),
  ].join('.');
}

export function decryptSecret(encoded: string, provider: KeyProvider): string {
  if (typeof encoded !== 'string') throw new EncryptionError('ciphertext must be a string');

  const parts = encoded.split('.');
  if (parts.length !== 5) throw new EncryptionError('malformed ciphertext');

  const [version, keyId, ivPart, tagPart, dataPart] = parts as [
    string,
    string,
    string,
    string,
    string,
  ];
  if (version !== FORMAT_VERSION) {
    throw new EncryptionError(`unsupported ciphertext version: ${version}`);
  }

  const iv = Buffer.from(ivPart, 'base64url');
  const authTag = Buffer.from(tagPart, 'base64url');
  if (iv.length !== IV_BYTES || authTag.length !== AUTH_TAG_BYTES) {
    throw new EncryptionError('malformed ciphertext parameters');
  }

  const decipher = createDecipheriv('aes-256-gcm', provider.getKey(keyId), iv);
  decipher.setAAD(Buffer.from(`${version}.${keyId}`, 'utf8'));
  decipher.setAuthTag(authTag);

  try {
    return Buffer.concat([
      decipher.update(Buffer.from(dataPart, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    // GCM tag mismatch: the row was tampered with or the wrong key was used.
    throw new EncryptionError('ciphertext failed authentication');
  }
}

/** Which key a stored ciphertext uses, for rotation reporting. */
export function ciphertextKeyId(encoded: string): string | null {
  const parts = encoded.split('.');
  return parts.length === 5 && parts[0] === FORMAT_VERSION ? (parts[1] as string) : null;
}
