/**
 * Log redaction (SPEC section 22, engineering rule #8).
 *
 * Nothing in this system may log a private key, seed phrase, API secret,
 * webhook secret or auth token. Redaction is applied centrally rather than
 * trusted to every call site, because the one call site that forgets is the
 * one that ends up in an incident report.
 *
 * The approach is deny-by-key-name plus value-shape detection: a field whose
 * NAME looks sensitive is redacted regardless of content, and a value that
 * LOOKS like a credential is redacted regardless of its field name.
 */

export const REDACTED = '[REDACTED]';

/** Field names whose values never appear in logs, matched case-insensitively. */
const SENSITIVE_KEY_PATTERNS: readonly RegExp[] = [
  /pass(word|phrase)/i,
  /secret/i,
  /token/i,
  /api[-_]?key/i,
  /private[-_]?key/i,
  /seed/i,
  /mnemonic/i,
  /credential/i,
  /authorization/i,
  /cookie/i,
  /session/i,
  /signature/i,
  /^pin$/i,
  /^otp$/i,
  /mfa/i,
  /xpriv|xprv/i,
];

/** Value shapes that are credentials no matter what field they arrived in. */
const SENSITIVE_VALUE_PATTERNS: readonly RegExp[] = [
  // Our own credential formats.
  /\bpk_(live|test)_[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{32,}/,
  /\bwhsec_[A-Za-z0-9_-]{32,}/,
  // JWTs.
  /\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  // Extended private keys.
  /\b(xprv|yprv|zprv|tprv)[A-Za-z0-9]{50,}/,
  // A raw 32-byte hex private key.
  /\b0x[a-fA-F0-9]{64}\b(?=.*(?:priv|secret|key))/i,
  // PEM blocks.
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERNS.some((pattern) => pattern.test(key));
}

function redactString(value: string): string {
  let output = value;
  for (const pattern of SENSITIVE_VALUE_PATTERNS) {
    output = output.replace(new RegExp(pattern.source, `g${pattern.flags.replace('g', '')}`), REDACTED);
  }
  return output;
}

/**
 * BIP-39 seed phrases are 12-24 dictionary words. Rather than ship the whole
 * wordlist here, treat any long run of lowercase words in a field that also
 * looks phrase-like as sensitive; the key-name rule catches the rest.
 */
export function looksLikeMnemonic(value: string): boolean {
  const words = value.trim().split(/\s+/);
  if (words.length < 12 || words.length > 24) return false;
  return words.every((word) => /^[a-z]{3,8}$/.test(word));
}

export interface RedactOptions {
  maxDepth?: number;
  /** Extra field names to redact for a particular call site. */
  additionalKeys?: readonly string[];
}

/**
 * Deep-copy a value with every sensitive field replaced. Cycles are broken,
 * depth is bounded, and unknown exotic types degrade to their type name rather
 * than being serialised blindly.
 */
export function redact<T>(value: T, options: RedactOptions = {}): unknown {
  const maxDepth = options.maxDepth ?? 8;
  const extraKeys = new Set((options.additionalKeys ?? []).map((k) => k.toLowerCase()));
  const seen = new WeakSet<object>();

  function walk(input: unknown, depth: number): unknown {
    if (depth > maxDepth) return '[MAX_DEPTH]';

    if (input === null || input === undefined) return input;

    if (typeof input === 'string') {
      return looksLikeMnemonic(input) ? REDACTED : redactString(input);
    }

    if (typeof input === 'number' || typeof input === 'boolean') return input;
    if (typeof input === 'bigint') return input.toString();
    if (typeof input === 'function') return '[Function]';
    if (typeof input === 'symbol') return '[Symbol]';

    if (input instanceof Date) return input.toISOString();
    if (input instanceof Error) {
      return { name: input.name, message: redactString(input.message) };
    }
    if (Buffer.isBuffer(input)) return `[Buffer ${input.length}]`;

    if (typeof input === 'object') {
      if (seen.has(input)) return '[Circular]';
      seen.add(input);

      if (Array.isArray(input)) {
        return input.map((item) => walk(item, depth + 1));
      }

      const output: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(input as Record<string, unknown>)) {
        output[key] =
          isSensitiveKey(key) || extraKeys.has(key.toLowerCase())
            ? REDACTED
            : walk(item, depth + 1);
      }
      return output;
    }

    return '[Unknown]';
  }

  return walk(value, 0);
}

/** Mask a credential for display: `pk_live_7fA2xK9m...` */
export function maskCredential(value: string, visiblePrefix = 12): string {
  if (typeof value !== 'string' || value.length === 0) return REDACTED;
  if (value.length <= visiblePrefix) return REDACTED;
  return `${value.slice(0, visiblePrefix)}...`;
}
