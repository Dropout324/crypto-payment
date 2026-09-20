import type { PendingSigningRequest } from './approval-store.js';
import type { SignedTransaction } from './types.js';

export * from './types.js';
export * from './errors.js';
export * from './signing-backend.js';
export * from './policy.js';
export * from './spend-tracker.js';
export * from './approval-store.js';
export * from './audit-trail.js';
export * from './hsm-key-store.js';
export * from './hsm-signing-backend.js';
export * from './policy-signing-service.js';

/** `submit()`/`approve()` return one of two shapes - this is how a caller tells them apart. */
export function isSignedTransaction(value: SignedTransaction | PendingSigningRequest): value is SignedTransaction {
  return 'rawTxHex' in value;
}
