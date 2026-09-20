import type { SigningAuditEvent, SigningAuditTrail } from '@gateway/signing';
import { AuditLogService } from '../common/audit-log.service.js';

/**
 * Writes every signing event into the existing append-only `audit_logs`
 * table (SPEC section 22) rather than a new one - "every privileged action
 * lands here" already holds for this table, and a signing decision is
 * exactly that. `AuditLogService.record()` redacts `metadata` before it
 * commits, a second line of defence alongside `SigningAuditEvent.detail`
 * already being pre-serialized and key-material-free at the call site
 * (`PolicyEnforcingSigningService`, `HsmBackedSigningBackend`).
 *
 * `event.actorId` is `null` for events with no specific human actor (e.g.
 * `HsmBackedSigningBackend`'s own `key_used` record) - passed through as
 * `actorUserId: undefined`, so `AuditLogService.record()` writes
 * `actorType: "system"` with no `userId` foreign key, rather than pointing
 * that key at a fabricated user id.
 */
export class PrismaSigningAuditTrail implements SigningAuditTrail {
  constructor(private readonly auditLog: AuditLogService) {}

  async record(event: SigningAuditEvent): Promise<void> {
    await this.auditLog.record({
      actorUserId: event.actorId ?? undefined,
      action: `signing_request.${event.type}`,
      resourceType: 'signing_request',
      resourceId: event.requestId,
      metadata: { ...event.detail, occurred_at: event.occurredAt.toISOString() },
    });
  }
}
