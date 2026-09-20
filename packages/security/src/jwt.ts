import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Session JWTs (dashboard login, Phase 7).
 *
 * Hand-rolled HS256 rather than a library: this is the same amount of code as
 * `webhook-signature.ts`'s HMAC signing, and matches this codebase's pattern
 * of keeping small crypto primitives auditable in `packages/security` instead
 * of pulling in a framework module for them.
 *
 * Access tokens are short-lived and stateless (verified here, no DB lookup).
 * Refresh tokens are a separate concern: opaque values from
 * `generateOpaqueToken` in `api-key.ts`, stored hashed in the `Session` table
 * so they can be revoked - a JWT, once issued, cannot be un-issued before it
 * expires, which is why only the long-lived refresh token is a stored,
 * revocable session.
 */

const HEADER = { alg: 'HS256', typ: 'JWT' } as const;

export class JwtError extends Error {}

export interface SignJwtOptions {
  expiresInSeconds: number;
  issuer: string;
  audience: string;
}

export interface VerifyJwtOptions {
  issuer: string;
  audience: string;
  /** Override for deterministic tests. */
  nowSeconds?: number;
}

function base64url(input: string): string {
  return Buffer.from(input, 'utf8').toString('base64url');
}

function signingInput(headerPart: string, payloadPart: string): string {
  return `${headerPart}.${payloadPart}`;
}

export function signJwt(claims: Record<string, unknown>, secret: string, options: SignJwtOptions): string {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    ...claims,
    iss: options.issuer,
    aud: options.audience,
    iat: now,
    exp: now + options.expiresInSeconds,
  };

  const headerPart = base64url(JSON.stringify(HEADER));
  const payloadPart = base64url(JSON.stringify(payload));
  const signature = createHmac('sha256', secret).update(signingInput(headerPart, payloadPart)).digest('base64url');

  return `${headerPart}.${payloadPart}.${signature}`;
}

/**
 * Verify a token's signature, expiry, issuer and audience. Throws `JwtError`
 * on any failure - callers never need to distinguish "expired" from
 * "tampered" in the response they send back, only in what they log.
 */
export function verifyJwt<T extends Record<string, unknown> = Record<string, unknown>>(
  token: string,
  secret: string,
  options: VerifyJwtOptions,
): T {
  if (typeof token !== 'string' || token.length === 0 || token.length > 8192) {
    throw new JwtError('malformed token');
  }

  const parts = token.split('.');
  if (parts.length !== 3) throw new JwtError('malformed token');
  const [headerPart, payloadPart, signaturePart] = parts;
  if (!headerPart || !payloadPart || !signaturePart) throw new JwtError('malformed token');

  const expectedSignature = createHmac('sha256', secret)
    .update(signingInput(headerPart, payloadPart))
    .digest('base64url');

  const presented = Buffer.from(signaturePart);
  const expected = Buffer.from(expectedSignature);
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
    throw new JwtError('signature mismatch');
  }

  let claims: Record<string, unknown>;
  try {
    claims = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8'));
  } catch {
    throw new JwtError('malformed payload');
  }

  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (typeof claims.exp !== 'number' || claims.exp <= now) {
    throw new JwtError('token expired');
  }
  if (claims.iss !== options.issuer) {
    throw new JwtError('issuer mismatch');
  }
  if (claims.aud !== options.audience) {
    throw new JwtError('audience mismatch');
  }

  return claims as T;
}
