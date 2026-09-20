/**
 * "Every signing request and decision is audited" (Phase 12 exit criteria,
 * `docs/commercial/readiness-roadmap.md`) - a durable, restart-surviving log
 * of every state transition `PolicyEnforcingSigningService` and
 * `HsmBackedSigningBackend` make, independent of `ApprovalStore` (which only
 * holds the *current* state of a request, not its history).
 *
 * `detail` must never carry key material or a full `SigningRequest.amount`
 * as a `bigint` (not JSON-safe) - callers pass it pre-serialized. This
 * package has no logger and no database of its own (ADR 0013: no dependency
 * on any other package in this monorepo), so `InMemorySigningAuditTrail` is
 * a development/test default only, same posture as `SpendTracker` and
 * `ApprovalStore` - a real deployment wires a durable implementation (see
 * `apps/api`'s `PrismaSigningAuditTrail`, which writes into the existing
 * append-only `audit_logs` table rather than a new one).
 */
export type SigningAuditEventType =
  | 'submitted'
  | 'approved'
  | 'rejected'
  | 'signed'
  | 'validation_failed'
  | 'sign_failed'
  | 'key_used';

export interface SigningAuditEvent {
  requestId: string;
  type: SigningAuditEventType;
  /** The user id behind this event, or `null` for a system-originated one (e.g. a ceiling check that runs with no specific actor). */
  actorId: string | null;
  occurredAt: Date;
  /** Pre-serialized, redaction-safe context - e.g. `{ reason: '...' }` or `{ amount: '1000000' }`. Never a key, never a raw `bigint`. */
  detail: Record<string, unknown>;
}

export interface SigningAuditTrail {
  record(event: SigningAuditEvent): Promise<void>;
}

export class InMemorySigningAuditTrail implements SigningAuditTrail {
  private readonly events: SigningAuditEvent[] = [];

  async record(event: SigningAuditEvent): Promise<void> {
    this.events.push(event);
  }

  /** Test/inspection only - a real durable trail is queried through its own store, not this class. */
  list(requestId?: string): readonly SigningAuditEvent[] {
    return requestId ? this.events.filter((e) => e.requestId === requestId) : this.events;
  }
}
