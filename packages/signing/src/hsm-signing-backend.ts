import { createHash } from 'node:crypto';
import type { SigningAuditTrail } from './audit-trail.js';
import { NoKeyMappedError } from './errors.js';
import type { HsmKeyStore } from './hsm-key-store.js';
import type { SignedTransaction, SigningRequest } from './types.js';
import type { SigningBackend } from './signing-backend.js';

/** Resolves which key in the `HsmKeyStore` signs on behalf of a given source address. A real deployment backs this with the `wallets`/`wallet_accounts` tables (`Wallet.signingKeyRef`); this package stays database-free (ADR 0013), so only a static, in-memory mapping ships here. */
export interface KeyMapping {
  resolveKeyId(fromAddress: string, network: string): Promise<string>;
}

export class StaticKeyMapping implements KeyMapping {
  private readonly byAddress = new Map<string, string>();

  constructor(entries: ReadonlyArray<{ fromAddress: string; network: string; keyId: string }> = []) {
    for (const entry of entries) {
      this.byAddress.set(StaticKeyMapping.key(entry.fromAddress, entry.network), entry.keyId);
    }
  }

  set(fromAddress: string, network: string, keyId: string): void {
    this.byAddress.set(StaticKeyMapping.key(fromAddress, network), keyId);
  }

  async resolveKeyId(fromAddress: string, network: string): Promise<string> {
    const keyId = this.byAddress.get(StaticKeyMapping.key(fromAddress, network));
    if (!keyId) throw new NoKeyMappedError(fromAddress, network);
    return keyId;
  }

  private static key(fromAddress: string, network: string): string {
    return `${network}:${fromAddress.toLowerCase()}`;
  }
}

/**
 * A `SigningBackend` backed by an `HsmKeyStore` - the reference/staging
 * adapter Phase 12 delivers in place of a real cloud KMS/HSM integration
 * (none exists to build and test against - same gap ADR 0013 already
 * disclosed for `DisabledSigningBackend`).
 *
 * **What this signs, precisely:** the SHA-256 digest of a canonical JSON
 * encoding of the `SigningRequest`'s own fields (id, network, asset,
 * from/to address, amount, requested-by, requested-at) - not a
 * chain-serialized raw transaction. Producing an actual broadcastable
 * transaction requires chain-specific data this package deliberately does
 * not hold (a nonce, gas parameters, RLP/PSBT encoding - `packages/blockchain`'s
 * job, per ADR 0013's "no chain-specific... knowledge" boundary). The
 * `rawTxHex` field therefore carries a DER-encoded ECDSA signature over that
 * canonical payload, hex-encoded - proving the signing architecture and key
 * isolation end to end, not a live broadcast path. Composing that into a
 * real transaction, for whichever chain, is future work gated on the
 * custody decision this roadmap leaves open (`docs/commercial/readiness-roadmap.md`,
 * "Open decisions" #4).
 *
 * Every call records a `key_used` audit event (key id and request id only -
 * never key material) through the supplied `SigningAuditTrail`, independent
 * of whatever audit trail `PolicyEnforcingSigningService` itself keeps -
 * this is the backend's own record of which physical key produced which
 * signature, the thing a key-compromise investigation needs first.
 */
export class HsmBackedSigningBackend implements SigningBackend {
  constructor(
    private readonly keyStore: HsmKeyStore,
    private readonly keyMapping: KeyMapping,
    private readonly auditTrail: SigningAuditTrail,
  ) {}

  async sign(request: SigningRequest): Promise<SignedTransaction> {
    const keyId = await this.keyMapping.resolveKeyId(request.fromAddress, request.network);
    const digest = HsmBackedSigningBackend.canonicalDigest(request);

    try {
      const signature = await this.keyStore.sign(keyId, digest);
      await this.auditTrail.record({
        requestId: request.id,
        type: 'key_used',
        actorId: null,
        occurredAt: new Date(),
        detail: { keyId, network: request.network },
      });
      return { requestId: request.id, rawTxHex: `0x${signature.toString('hex')}`, signedAt: new Date() };
    } catch (error) {
      await this.auditTrail.record({
        requestId: request.id,
        type: 'sign_failed',
        actorId: null,
        occurredAt: new Date(),
        detail: { keyId, reason: error instanceof Error ? error.message : String(error) },
      });
      throw error;
    }
  }

  /** Deterministic across calls for the same request - the digest a signature can be independently re-verified against, without re-deriving it from a live request object. */
  static canonicalDigest(request: SigningRequest): Buffer {
    const canonical = JSON.stringify({
      id: request.id,
      network: request.network,
      asset: request.asset,
      fromAddress: request.fromAddress.toLowerCase(),
      toAddress: request.toAddress.toLowerCase(),
      amount: request.amount.toString(),
      requestedBy: request.requestedBy,
      requestedAt: request.requestedAt.toISOString(),
    });
    return createHash('sha256').update(canonical).digest();
  }
}
