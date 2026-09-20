import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Algorithm, hash, verify } from '@node-rs/argon2';

/**
 * API credentials.
 *
 * An API key is two halves joined by an underscore:
 *
 *   pk_live_7fA2xK9m.s3cr3tPortionThatIsNeverStored
 *   ^--------------^ ^--------------------------------^
 *      public id            secret, hashed at rest
 *
 * The public id is safe to log, display and index. The secret is hashed with
 * Argon2id and returned to the merchant exactly once (SPEC section 15).
 *
 * Cost note: verifying Argon2id on every API request is too slow for a payment
 * API. The public id narrows the lookup to a single row first, so exactly one
 * Argon2 verification runs per request - and a wrong prefix costs nothing.
 */

const PUBLIC_ID_BYTES = 9; // 12 base64url chars
const SECRET_BYTES = 32; // 256 bits

export type KeyEnvironment = 'live' | 'test';

export interface GeneratedApiKey {
  /** Full credential, shown to the merchant once and never persisted. */
  plaintext: string;
  /** Public half, stored and displayed. */
  keyPrefix: string;
  /** Argon2id hash of the secret half; this is what goes in the database. */
  secretHash: string;
  livemode: boolean;
}

export interface ParsedApiKey {
  keyPrefix: string;
  secret: string;
  livemode: boolean;
}

function base64url(buffer: Buffer): string {
  return buffer.toString('base64url');
}

/**
 * Argon2 parameters for API keys are deliberately lighter than for passwords:
 * the secret is 256 bits of machine-generated entropy, so it is not subject to
 * dictionary attack, and this runs on every authenticated request.
 */
const API_KEY_ARGON2 = {
  algorithm: Algorithm.Argon2id,
  memoryCost: 8_192,
  timeCost: 1,
  parallelism: 1,
} as const;

export async function generateApiKey(environment: KeyEnvironment = 'test'): Promise<GeneratedApiKey> {
  const publicId = base64url(randomBytes(PUBLIC_ID_BYTES));
  const secret = base64url(randomBytes(SECRET_BYTES));

  const keyPrefix = `pk_${environment}_${publicId}`;
  const plaintext = `${keyPrefix}.${secret}`;

  return {
    plaintext,
    keyPrefix,
    secretHash: await hash(secret, API_KEY_ARGON2),
    livemode: environment === 'live',
  };
}

/**
 * Split a presented credential. Returns null for anything malformed, so the
 * caller performs no database work on garbage input.
 */
export function parseApiKey(presented: string): ParsedApiKey | null {
  if (typeof presented !== 'string') return null;

  const trimmed = presented.trim();
  // Exactly one separator; the secret is base64url and contains no dots.
  const separator = trimmed.indexOf('.');
  if (separator === -1 || trimmed.indexOf('.', separator + 1) !== -1) return null;

  const keyPrefix = trimmed.slice(0, separator);
  const secret = trimmed.slice(separator + 1);

  const match = /^pk_(live|test)_[A-Za-z0-9_-]{8,32}$/.exec(keyPrefix);
  if (!match) return null;
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(secret)) return null;

  return { keyPrefix, secret, livemode: match[1] === 'live' };
}

export async function verifyApiKeySecret(secret: string, secretHash: string): Promise<boolean> {
  if (!secret || !secretHash) return false;
  try {
    return await verify(secretHash, secret);
  } catch {
    return false;
  }
}

/**
 * Webhook signing secrets. Handed to the merchant once; stored encrypted (not
 * hashed) because we must reproduce the HMAC ourselves on every send.
 */
export function generateWebhookSecret(): string {
  return `whsec_${base64url(randomBytes(32))}`;
}

/**
 * Non-secret fingerprint of a secret, so a dashboard can show WHICH secret is
 * configured without being able to reconstruct it.
 */
export function secretFingerprint(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex').slice(0, 16);
}

/** Opaque session/refresh token plus the SHA-256 that is stored in its place. */
export function generateOpaqueToken(bytes = 32): { token: string; tokenHash: string } {
  const token = base64url(randomBytes(bytes));
  return { token, tokenHash: sha256Hex(token) };
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Constant-time comparison for values already reduced to a fixed length. */
export function timingSafeEqualHex(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, 'utf8');
  const bufferB = Buffer.from(b, 'utf8');
  if (bufferA.length !== bufferB.length) return false;
  return timingSafeEqual(bufferA, bufferB);
}
