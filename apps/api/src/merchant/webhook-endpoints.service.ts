import { Inject, Injectable } from '@nestjs/common';
import { NotFoundError, newId } from '@gateway/shared';
import { EnvKeyProvider, encryptSecret, generateWebhookSecret, secretFingerprint } from '@gateway/security';
import { type DatabaseClient, runInTransaction } from '@gateway/database';
import { PRISMA_CLIENT } from '../database/prisma.module.js';
import { type AuditMeta, AuditLogService } from '../common/audit-log.service.js';
import type { CreateWebhookEndpointDto, UpdateWebhookEndpointDto } from './webhook-endpoints.dto.js';

interface WebhookEndpointRow {
  id: string;
  url: string;
  eventTypes: string[];
  enabled: boolean;
  secretFingerprint: string;
  consecutiveFailures: number;
  disabledReason: string | null;
  createdAt: Date;
}

export interface WebhookEndpointResponse {
  id: string;
  url: string;
  event_types: string[];
  enabled: boolean;
  secret_fingerprint: string;
  consecutive_failures: number;
  disabled_reason: string | null;
  created_at: string;
}

export interface CreatedWebhookEndpointResponse extends WebhookEndpointResponse {
  /** Returned exactly once - encrypted at rest afterwards, never recoverable. */
  secret: string;
}

@Injectable()
export class WebhookEndpointsService {
  private readonly keyProvider = new EnvKeyProvider();

  constructor(
    @Inject(PRISMA_CLIENT) private readonly db: DatabaseClient,
    @Inject(AuditLogService) private readonly auditLog: AuditLogService,
  ) {}

  async list(merchantId: string): Promise<WebhookEndpointResponse[]> {
    const rows = await this.db.webhookEndpoint.findMany({
      where: { merchantId, deletedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((row) => this.toResponse(row));
  }

  async create(
    merchantId: string,
    userId: string,
    dto: CreateWebhookEndpointDto,
    meta: AuditMeta,
  ): Promise<CreatedWebhookEndpointResponse> {
    const secret = generateWebhookSecret();

    const created = await runInTransaction(this.db, async (tx) => {
      const row = await tx.webhookEndpoint.create({
        data: {
          id: newId('webhookEndpoint'),
          merchantId,
          url: dto.url,
          eventTypes: dto.event_types ?? [],
          secretEncrypted: encryptSecret(secret, this.keyProvider),
          secretFingerprint: secretFingerprint(secret),
          enabled: true,
        },
      });
      await this.auditLog.record(
        {
          actorUserId: userId,
          action: 'webhook_endpoint.created',
          resourceType: 'webhook_endpoint',
          resourceId: row.id,
          merchantId,
          after: { url: row.url, event_types: row.eventTypes },
          meta,
        },
        tx,
      );
      return row;
    });

    return { ...this.toResponse(created), secret };
  }

  async update(
    merchantId: string,
    userId: string,
    id: string,
    dto: UpdateWebhookEndpointDto,
    meta: AuditMeta,
  ): Promise<WebhookEndpointResponse> {
    const existing = await this.requireOwned(merchantId, id);

    const disabling = dto.enabled === false;
    const enabling = dto.enabled === true;

    const updated = await runInTransaction(this.db, async (tx) => {
      const row = await tx.webhookEndpoint.update({
        where: { id },
        data: {
          ...(dto.enabled !== undefined ? { enabled: dto.enabled } : {}),
          ...(disabling ? { disabledAt: new Date(), disabledReason: 'disabled by merchant' } : {}),
          ...(enabling ? { disabledAt: null, disabledReason: null, consecutiveFailures: 0 } : {}),
          ...(dto.event_types !== undefined ? { eventTypes: dto.event_types } : {}),
        },
      });
      await this.auditLog.record(
        {
          actorUserId: userId,
          action: 'webhook_endpoint.updated',
          resourceType: 'webhook_endpoint',
          resourceId: id,
          merchantId,
          before: { enabled: existing.enabled, event_types: existing.eventTypes },
          after: { enabled: row.enabled, event_types: row.eventTypes },
          meta,
        },
        tx,
      );
      return row;
    });

    return this.toResponse(updated);
  }

  /** The previous secret stays valid briefly so in-flight deliveries still verify (see ADR 0009). */
  async rotateSecret(merchantId: string, userId: string, id: string, meta: AuditMeta): Promise<CreatedWebhookEndpointResponse> {
    const existing = await this.requireOwned(merchantId, id);

    const secret = generateWebhookSecret();
    const updated = await runInTransaction(this.db, async (tx) => {
      const row = await tx.webhookEndpoint.update({
        where: { id },
        data: {
          previousSecretEncrypted: existing.secretEncrypted,
          secretEncrypted: encryptSecret(secret, this.keyProvider),
          secretFingerprint: secretFingerprint(secret),
          secretRotatedAt: new Date(),
        },
      });
      await this.auditLog.record(
        {
          actorUserId: userId,
          action: 'webhook_endpoint.secret_rotated',
          resourceType: 'webhook_endpoint',
          resourceId: id,
          merchantId,
          meta,
        },
        tx,
      );
      return row;
    });

    return { ...this.toResponse(updated), secret };
  }

  private async requireOwned(merchantId: string, id: string) {
    const existing = await this.db.webhookEndpoint.findFirst({ where: { id, merchantId, deletedAt: null } });
    if (!existing) throw new NotFoundError('webhook endpoint', id);
    return existing;
  }

  private toResponse(row: WebhookEndpointRow): WebhookEndpointResponse {
    return {
      id: row.id,
      url: row.url,
      event_types: row.eventTypes,
      enabled: row.enabled,
      secret_fingerprint: row.secretFingerprint,
      consecutive_failures: row.consecutiveFailures,
      disabled_reason: row.disabledReason,
      created_at: row.createdAt.toISOString(),
    };
  }
}
