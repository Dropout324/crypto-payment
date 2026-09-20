import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Webhook signatures (SPEC section 17).
 *
 * Signed value: `${timestampSeconds}.${rawBody}`
 * Header:       X-Signature: t=<unix seconds>,v1=<hex hmac-sha256>
 *
 * Including the timestamp INSIDE the signed string is what makes replay
 * protection work: an attacker cannot take yesterday's valid body and present
 * it with a fresh timestamp, because that changes the signed value.
 *
 * The signature is computed over the exact bytes sent. A merchant that
 * re-serialises the JSON before verifying will get a different string and a
 * failed check - the API docs must say "verify against the raw body".
 */

export const SIGNATURE_VERSION = 'v1';
export const DEFAULT_REPLAY_WINDOW_SECONDS = 300;

export interface SignedWebhook {
  /** Value for the X-Signature header. */
  signature: string;
  /** Value for the X-Timestamp header, seconds since epoch. */
  timestamp: number;
  signedPayload: string;
}

export function buildSignedPayload(timestampSeconds: number, rawBody: string): string {
  return `${timestampSeconds}.${rawBody}`;
}

export function computeSignature(secret: string, signedPayload: string): string {
  return createHmac('sha256', secret).update(signedPayload, 'utf8').digest('hex');
}

export function signWebhook(
  secret: string,
  rawBody: string,
  timestampSeconds: number = Math.floor(Date.now() / 1000),
): SignedWebhook {
  const signedPayload = buildSignedPayload(timestampSeconds, rawBody);
  const digest = computeSignature(secret, signedPayload);

  return {
    signature: `t=${timestampSeconds},${SIGNATURE_VERSION}=${digest}`,
    timestamp: timestampSeconds,
    signedPayload,
  };
}

export interface VerifyOptions {
  /** Reject signatures older (or further in the future) than this. */
  toleranceSeconds?: number;
  /** Override for deterministic tests. */
  nowSeconds?: number;
  /**
   * Previous secret, accepted during rotation so deliveries signed just before
   * a rotation still verify.
   */
  previousSecret?: string | null;
}

export type VerifyFailureReason =
  | 'malformed_header'
  | 'timestamp_out_of_range'
  | 'signature_mismatch';

export type VerifyResult =
  | { valid: true; timestamp: number; usedPreviousSecret: boolean }
  | { valid: false; reason: VerifyFailureReason };

interface ParsedHeader {
  timestamp: number;
  signatures: string[];
}

function parseSignatureHeader(header: string): ParsedHeader | null {
  if (typeof header !== 'string' || header.length === 0 || header.length > 1024) return null;

  let timestamp: number | null = null;
  const signatures: string[] = [];

  for (const part of header.split(',')) {
    const index = part.indexOf('=');
    if (index === -1) continue;

    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();

    if (key === 't') {
      if (!/^\d{1,15}$/.test(value)) return null;
      timestamp = Number(value);
    } else if (key === SIGNATURE_VERSION) {
      // A header may carry several v1 signatures during secret rotation.
      if (/^[a-f0-9]{64}$/.test(value)) signatures.push(value);
    }
  }

  if (timestamp === null || signatures.length === 0) return null;
  return { timestamp, signatures };
}

function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

/**
 * Verify a received webhook. This is the function a merchant implements on
 * their side; it lives here so the gateway can dogfood it in tests and ship it
 * verbatim in the docs and SDK.
 */
export function verifyWebhookSignature(
  secret: string,
  rawBody: string,
  signatureHeader: string,
  options: VerifyOptions = {},
): VerifyResult {
  const parsed = parseSignatureHeader(signatureHeader);
  if (!parsed) return { valid: false, reason: 'malformed_header' };

  const tolerance = options.toleranceSeconds ?? DEFAULT_REPLAY_WINDOW_SECONDS;
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);

  // Reject both stale signatures (replay) and ones from the future (a skewed
  // or malicious sender trying to extend the window).
  if (Math.abs(now - parsed.timestamp) > tolerance) {
    return { valid: false, reason: 'timestamp_out_of_range' };
  }

  const signedPayload = buildSignedPayload(parsed.timestamp, rawBody);

  const expected = computeSignature(secret, signedPayload);
  if (parsed.signatures.some((candidate) => safeEqualHex(candidate, expected))) {
    return { valid: true, timestamp: parsed.timestamp, usedPreviousSecret: false };
  }

  if (options.previousSecret) {
    const expectedPrevious = computeSignature(options.previousSecret, signedPayload);
    if (parsed.signatures.some((candidate) => safeEqualHex(candidate, expectedPrevious))) {
      return { valid: true, timestamp: parsed.timestamp, usedPreviousSecret: true };
    }
  }

  return { valid: false, reason: 'signature_mismatch' };
}
