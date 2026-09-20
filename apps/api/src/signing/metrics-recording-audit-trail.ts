import type { SigningAuditEvent, SigningAuditTrail } from '@gateway/signing';
import type { FinancialMetrics } from '@gateway/observability';

/**
 * Decorates a real `SigningAuditTrail` (in production, `PrismaSigningAuditTrail`)
 * with the "signing failure" alert's metric (Phase 16/C6): every
 * `validation_failed` (a policy check - destination allowlist, amount
 * ceiling - rejected the request before it ever reached the backend) and
 * `sign_failed` (the backend itself threw) event increments
 * `gateway_signing_failures_total{stage}`, by that same event type. The
 * underlying trail still records every event exactly as before - this only
 * observes, never changes what gets written or returned.
 */
const FAILURE_STAGES = new Set(['validation_failed', 'sign_failed']);

export class MetricsRecordingSigningAuditTrail implements SigningAuditTrail {
  constructor(
    private readonly delegate: SigningAuditTrail,
    private readonly metrics: FinancialMetrics,
  ) {}

  async record(event: SigningAuditEvent): Promise<void> {
    if (FAILURE_STAGES.has(event.type)) {
      this.metrics.signingFailures.inc({ stage: event.type });
    }
    await this.delegate.record(event);
  }
}
