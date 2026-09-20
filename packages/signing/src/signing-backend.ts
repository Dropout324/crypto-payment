import { SigningNotConfiguredError } from './errors.js';
import type { SignedTransaction, SigningRequest } from './types.js';

/**
 * The seam a real KMS/HSM integration implements - see ADR 0002 ("the
 * application never holds private keys... signing is delegated to a
 * policy-enforcing service backed by a KMS/HSM") and ADR 0012's
 * `SecretsProvider` for the same posture applied to a different problem.
 *
 * `PolicyEnforcingSigningService` never calls this directly with unchecked
 * input - every call it makes has already passed the destination allowlist,
 * amount ceilings, and approval count in `policy-signing-service.ts`.
 */
export interface SigningBackend {
  sign(request: SigningRequest): Promise<SignedTransaction>;
}

/**
 * The only `SigningBackend` shipped here. Always throws - fail closed, not
 * fail open - specifically so that wiring this package up anywhere before a
 * real KMS/HSM backend exists cannot produce an actual signature. No cloud
 * KMS/HSM account exists to build and test a real backend against yet; see
 * ADR 0013 for why that gap is left open rather than papered over with an
 * untested implementation.
 */
export class DisabledSigningBackend implements SigningBackend {
  async sign(): Promise<SignedTransaction> {
    throw new SigningNotConfiguredError(
      'no signing backend is configured - Mode A (custodial) requires a KMS/HSM-backed SigningBackend before this can be enabled (see ADR 0002, ADR 0013)',
    );
  }
}
