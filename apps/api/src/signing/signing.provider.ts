import type { Provider } from '@nestjs/common';
import {
  DisabledSigningBackend,
  EmulatedHsmKeyStore,
  HsmBackedSigningBackend,
  PolicyEnforcingSigningService,
  StaticKeyMapping,
  type SigningPolicy,
} from '@gateway/signing';
import type { DatabaseClient } from '@gateway/database';
import type { FinancialMetrics } from '@gateway/observability';
import { APP_CONFIG, type AppConfig } from '../config/env.js';
import { PRISMA_CLIENT } from '../database/prisma.module.js';
import { AuditLogService } from '../common/audit-log.service.js';
import { FINANCIAL_METRICS } from '../observability/financial-metrics.provider.js';
import { PrismaApprovalStore } from './prisma-approval-store.js';
import { PrismaSpendTracker } from './prisma-spend-tracker.js';
import { PrismaSigningAuditTrail } from './prisma-signing-audit-trail.js';
import { MetricsRecordingSigningAuditTrail } from './metrics-recording-audit-trail.js';

export const SIGNING_SERVICE = 'SIGNING_SERVICE';

/**
 * Composes `PolicyEnforcingSigningService` for `apps/api` - the "wired into
 * the application" half of Phase 12's exit criteria. Every piece is durable
 * (`PrismaApprovalStore`, `PrismaSpendTracker`, `PrismaSigningAuditTrail`);
 * only the backend is a choice, gated by `config.signingBackend`
 * (`SIGNING_BACKEND` env var) and refused outside `"disabled"` in production
 * by `validateProductionConfig` (`config/env.ts`, ADR 0026) - Mode A
 * (custodial signing) is not live, and this factory cannot make it live: it
 * has no code path that composes a broadcastable transaction, only a
 * signature over a canonical request payload (see `HsmBackedSigningBackend`'s
 * own doc comment).
 *
 * The policy itself is one global, statically-configured `SigningPolicy` -
 * not per-merchant or per-network - a deliberate simplification disclosed in
 * ADR 0026 given no real KMS/HSM account exists yet to justify more.
 */
export const signingServiceProvider: Provider = {
  provide: SIGNING_SERVICE,
  useFactory: (
    config: AppConfig,
    db: DatabaseClient,
    auditLog: AuditLogService,
    financialMetrics: FinancialMetrics,
  ): PolicyEnforcingSigningService => {
    const auditTrail = new MetricsRecordingSigningAuditTrail(new PrismaSigningAuditTrail(auditLog), financialMetrics);

    const backend =
      config.signingBackend === 'emulated-hsm-staging'
        ? new HsmBackedSigningBackend(new EmulatedHsmKeyStore(), new StaticKeyMapping(), auditTrail)
        : new DisabledSigningBackend();

    const policy: SigningPolicy = {
      network: '*',
      allowedDestinations: new Set(config.signingAllowedDestinations),
      maxAmountPerTx: config.signingMaxAmountPerTx,
      maxAmountPerWindow: config.signingMaxAmountPerWindow,
      windowSeconds: config.signingWindowSeconds,
      requiredApprovals: config.signingRequiredApprovals,
    };

    return new PolicyEnforcingSigningService(
      backend,
      policy,
      new PrismaSpendTracker(db),
      new PrismaApprovalStore(db),
      auditTrail,
    );
  },
  inject: [APP_CONFIG, PRISMA_CLIENT, AuditLogService, FINANCIAL_METRICS],
};
