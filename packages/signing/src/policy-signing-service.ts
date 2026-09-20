import type { ApprovalStore, PendingSigningRequest } from './approval-store.js';
import { InMemorySigningAuditTrail, type SigningAuditTrail } from './audit-trail.js';
import {
  AmountCeilingExceededError,
  DestinationNotAllowedError,
  SelfApprovalError,
  SigningRequestAlreadyDecidedError,
  UnknownSigningRequestError,
} from './errors.js';
import type { SigningPolicy } from './policy.js';
import type { SigningBackend } from './signing-backend.js';
import type { SpendTracker } from './spend-tracker.js';
import type { SignedTransaction, SigningRequest } from './types.js';

/** JSON/audit-safe serialization of a `SigningRequest` - never leaks past this file's boundary as a `bigint`. */
function requestSummary(request: SigningRequest): Record<string, unknown> {
  return {
    merchantId: request.merchantId,
    network: request.network,
    asset: request.asset,
    toAddress: request.toAddress,
    amount: request.amount.toString(),
  };
}

/**
 * Enforces `SigningPolicy` in front of a `SigningBackend` - the "policy
 * controls" ADR 0002 requires before Mode A can exist. Every check here
 * runs before `SigningBackend.sign()` is ever called, so a caller cannot
 * reach the backend with a request this policy would have rejected.
 *
 * `auditTrail` defaults to an in-memory sink (development/test only, same
 * posture as `SpendTracker`/`ApprovalStore`'s own in-memory defaults) so
 * every existing caller that built this with four arguments is unaffected;
 * a production deployment passes a durable implementation explicitly (see
 * `apps/api`'s `PrismaSigningAuditTrail`).
 */
export class PolicyEnforcingSigningService {
  constructor(
    private readonly backend: SigningBackend,
    private readonly policy: SigningPolicy,
    private readonly spendTracker: SpendTracker,
    private readonly approvals: ApprovalStore,
    private readonly auditTrail: SigningAuditTrail = new InMemorySigningAuditTrail(),
  ) {}

  /**
   * `policy.requiredApprovals <= 1` signs immediately (the requester's own
   * submission is sufficient approval). Otherwise this records a pending
   * request and returns it - call `approve()` separately as each approver
   * signs off.
   */
  async submit(request: SigningRequest): Promise<SignedTransaction | PendingSigningRequest> {
    await this.audit(request.id, 'submitted', request.requestedBy, requestSummary(request));

    try {
      this.assertDestinationAllowed(request);
      await this.assertWithinCeilings(request);
    } catch (error) {
      await this.auditValidationFailure(request.id, request.requestedBy, error);
      throw error;
    }

    if (this.policy.requiredApprovals <= 1) {
      return this.finalizeAndSign(request, [request.requestedBy]);
    }

    const pending: PendingSigningRequest = { request, status: 'PENDING_APPROVAL', approvals: [] };
    await this.approvals.save(pending);
    return pending;
  }

  /**
   * Records one approval. Once `requiredApprovals` distinct approvers have
   * signed off, this re-checks the amount ceilings (budget may have been
   * consumed by another request while this one was waiting) and signs.
   * Re-approving with the same `approverId` is a no-op, not an error - an
   * approver double-clicking a button should never fail loudly.
   */
  async approve(requestId: string, approverId: string): Promise<SignedTransaction | PendingSigningRequest> {
    const pending = await this.approvals.get(requestId);
    if (!pending) throw new UnknownSigningRequestError(requestId);
    if (pending.status !== 'PENDING_APPROVAL') {
      throw new SigningRequestAlreadyDecidedError(requestId, pending.status);
    }
    if (pending.request.requestedBy === approverId) {
      throw new SelfApprovalError();
    }
    if (pending.approvals.includes(approverId)) {
      return pending;
    }

    const approvals = [...pending.approvals, approverId];
    await this.audit(requestId, 'approved', approverId, { approvalCount: approvals.length, required: this.policy.requiredApprovals });

    if (approvals.length >= this.policy.requiredApprovals) {
      try {
        await this.assertWithinCeilings(pending.request);
      } catch (error) {
        await this.auditValidationFailure(requestId, approverId, error);
        throw error;
      }
      return this.finalizeAndSign(pending.request, approvals);
    }

    const updated: PendingSigningRequest = { ...pending, approvals };
    await this.approvals.save(updated);
    return updated;
  }

  /** Rejects a pending request outright - it never reaches `SigningBackend.sign()` regardless of how many approvals it already has. */
  async reject(requestId: string, actorId: string, reason?: string): Promise<PendingSigningRequest> {
    const pending = await this.approvals.get(requestId);
    if (!pending) throw new UnknownSigningRequestError(requestId);
    if (pending.status !== 'PENDING_APPROVAL') {
      throw new SigningRequestAlreadyDecidedError(requestId, pending.status);
    }

    const updated: PendingSigningRequest = { ...pending, status: 'REJECTED', rejectedBy: actorId, rejectionReason: reason };
    await this.approvals.save(updated);
    await this.audit(requestId, 'rejected', actorId, reason ? { reason } : {});
    return updated;
  }

  private assertDestinationAllowed(request: SigningRequest): void {
    if (!this.policy.allowedDestinations.has(request.toAddress.toLowerCase())) {
      throw new DestinationNotAllowedError(
        `destination ${request.toAddress} is not on the ${request.network} signing allowlist`,
      );
    }
  }

  private async assertWithinCeilings(request: SigningRequest): Promise<void> {
    if (request.amount > this.policy.maxAmountPerTx) {
      throw new AmountCeilingExceededError(
        `amount ${request.amount} exceeds the per-transaction ceiling of ${this.policy.maxAmountPerTx}`,
      );
    }

    const windowTotal = await this.spendTracker.windowTotal(
      request.merchantId,
      request.network,
      this.policy.windowSeconds,
      request.requestedAt,
    );
    if (windowTotal + request.amount > this.policy.maxAmountPerWindow) {
      throw new AmountCeilingExceededError(
        `amount ${request.amount} would bring the ${this.policy.windowSeconds}s rolling total to ${
          windowTotal + request.amount
        }, exceeding the ceiling of ${this.policy.maxAmountPerWindow}`,
      );
    }
  }

  private async finalizeAndSign(request: SigningRequest, approvals: readonly string[]): Promise<SignedTransaction> {
    try {
      const signed = await this.backend.sign(request);
      await this.spendTracker.record(request.merchantId, request.network, request.amount, request.requestedAt);
      await this.approvals.save({ request, status: 'SIGNED', approvals });
      await this.audit(request.id, 'signed', request.requestedBy, { rawTxHex: signed.rawTxHex });
      return signed;
    } catch (error) {
      await this.audit(request.id, 'sign_failed', request.requestedBy, {
        reason: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private async auditValidationFailure(requestId: string, actorId: string, error: unknown): Promise<void> {
    await this.audit(requestId, 'validation_failed', actorId, {
      reason: error instanceof Error ? error.message : String(error),
    });
  }

  private async audit(
    requestId: string,
    type: 'submitted' | 'approved' | 'rejected' | 'signed' | 'validation_failed' | 'sign_failed',
    actorId: string | null,
    detail: Record<string, unknown>,
  ): Promise<void> {
    await this.auditTrail.record({ requestId, type, actorId, occurredAt: new Date(), detail });
  }
}
