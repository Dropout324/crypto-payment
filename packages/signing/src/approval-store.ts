import type { SigningRequest } from './types.js';

export type SigningRequestStatus = 'PENDING_APPROVAL' | 'SIGNED' | 'REJECTED';

export interface PendingSigningRequest {
  request: SigningRequest;
  status: SigningRequestStatus;
  /** Deduplicated approver user ids, in the order they approved. */
  approvals: readonly string[];
  /** Set only when `status === 'REJECTED'`. */
  rejectedBy?: string;
  rejectionReason?: string;
}

/** Persisted state for multi-approval requests. Same "seam, not the production store" posture as `SpendTracker` - a real deployment needs this durable across restarts. */
export interface ApprovalStore {
  save(entry: PendingSigningRequest): Promise<void>;
  get(requestId: string): Promise<PendingSigningRequest | undefined>;
}

export class InMemoryApprovalStore implements ApprovalStore {
  private readonly byId = new Map<string, PendingSigningRequest>();

  async save(entry: PendingSigningRequest): Promise<void> {
    this.byId.set(entry.request.id, entry);
  }

  async get(requestId: string): Promise<PendingSigningRequest | undefined> {
    return this.byId.get(requestId);
  }
}
