/**
 * Retry backoff for webhook delivery (SPEC section 18).
 *
 * Each `webhook_deliveries` row is one attempt (schema comment: "retrying is
 * an insert, never an overwrite" - see ADR 0009), so this module's only job is
 * to answer "how long until the NEXT attempt", given the attempt number that
 * just failed.
 */

export interface RetryPolicyOptions {
  /** Delay before the second attempt. */
  baseDelayMs?: number;
  /** Backoff never exceeds this, no matter how many attempts have failed. */
  maxDelayMs?: number;
  /** +/- this fraction of the exponential value, so retrying endpoints do not resynchronise. */
  jitterRatio?: number;
}

export const DEFAULT_BASE_DELAY_MS = 30_000;
export const DEFAULT_MAX_DELAY_MS = 60 * 60 * 1000;
export const DEFAULT_JITTER_RATIO = 0.2;

/**
 * Delay in milliseconds before retrying, given that `failedAttempt` (1-based)
 * just failed. Grows exponentially and is capped, with jitter applied last so
 * the cap itself is never exceeded.
 */
export function computeRetryDelayMs(failedAttempt: number, options: RetryPolicyOptions = {}): number {
  if (!Number.isInteger(failedAttempt) || failedAttempt < 1) {
    throw new RangeError(`failedAttempt must be a positive integer, got ${failedAttempt}`);
  }

  const base = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const max = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const jitterRatio = options.jitterRatio ?? DEFAULT_JITTER_RATIO;

  const exponential = Math.min(max, base * 2 ** (failedAttempt - 1));
  const jitter = exponential * jitterRatio * (Math.random() * 2 - 1);
  return Math.max(0, Math.round(Math.min(max, exponential + jitter)));
}

export function isSuccessStatus(httpStatus: number): boolean {
  return httpStatus >= 200 && httpStatus < 300;
}
