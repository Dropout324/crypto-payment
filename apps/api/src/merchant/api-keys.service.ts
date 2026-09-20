import { Inject, Injectable } from '@nestjs/common';
import { NotFoundError, newId } from '@gateway/shared';
import { generateApiKey } from '@gateway/security';
import { type DatabaseClient, runInTransaction } from '@gateway/database';
import { PRISMA_CLIENT } from '../database/prisma.module.js';
import { ALL_API_KEY_SCOPES } from '../auth/api-key-scope.guard.js';
import { type AuditMeta, AuditLogService } from '../common/audit-log.service.js';
import type { CreateApiKeyDto } from './api-keys.dto.js';

interface ApiKeyRow {
  id: string;
  name: string;
  keyPrefix: string;
  livemode: boolean;
  scopes: string[];
  status: string;
  lastUsedAt: Date | null;
  createdAt: Date;
}

export interface ApiKeyResponse {
  id: string;
  name: string;
  key_prefix: string;
  livemode: boolean;
  scopes: string[];
  status: string;
  last_used_at: string | null;
  created_at: string;
}

export interface CreatedApiKeyResponse extends ApiKeyResponse {
  /** Returned exactly once, at creation - never recoverable afterwards. */
  plaintext: string;
}

/**
 * Merchant-dashboard API-key management. Distinct from `ApiKeyGuard`, which
 * only verifies a presented key - this is the "logged-in human creates
 * credentials for their server to use" side, so it lives behind
 * `JwtAuthGuard`, never behind an API key itself.
 */
@Injectable()
export class ApiKeysService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly db: DatabaseClient,
    @Inject(AuditLogService) private readonly auditLog: AuditLogService,
  ) {}

  async list(merchantId: string): Promise<ApiKeyResponse[]> {
    const rows = await this.db.apiKey.findMany({ where: { merchantId }, orderBy: { createdAt: 'desc' } });
    return rows.map((row) => this.toResponse(row));
  }

  async create(merchantId: string, userId: string, dto: CreateApiKeyDto, meta: AuditMeta): Promise<CreatedApiKeyResponse> {
    const generated = await generateApiKey(dto.livemode ? 'live' : 'test');

    const created = await runInTransaction(this.db, async (tx) => {
      const row = await tx.apiKey.create({
        data: {
          id: newId('apiKey'),
          merchantId,
          name: dto.name,
          keyPrefix: generated.keyPrefix,
          secretHash: generated.secretHash,
          livemode: generated.livemode,
          // No `scopes` in the request means "every scope" (see
          // `CreateApiKeyDto`), not "no scopes" - an empty array would make a
          // newly created key unable to call anything once `ApiKeyScopeGuard`
          // is in front of every scoped route.
          scopes: dto.scopes ?? [...ALL_API_KEY_SCOPES],
          status: 'ACTIVE',
        },
      });
      await this.auditLog.record(
        {
          actorUserId: userId,
          action: 'api_key.created',
          resourceType: 'api_key',
          resourceId: row.id,
          merchantId,
          after: { name: row.name, key_prefix: row.keyPrefix, livemode: row.livemode, scopes: row.scopes },
          meta,
        },
        tx,
      );
      return row;
    });

    return { ...this.toResponse(created), plaintext: generated.plaintext };
  }

  async revoke(merchantId: string, userId: string, apiKeyId: string, meta: AuditMeta): Promise<ApiKeyResponse> {
    const existing = await this.db.apiKey.findFirst({ where: { id: apiKeyId, merchantId } });
    if (!existing) throw new NotFoundError('api key', apiKeyId);

    const updated = await runInTransaction(this.db, async (tx) => {
      const row = await tx.apiKey.update({
        where: { id: apiKeyId },
        data: { status: 'REVOKED', revokedAt: new Date(), revokedBy: userId },
      });
      await this.auditLog.record(
        {
          actorUserId: userId,
          action: 'api_key.revoked',
          resourceType: 'api_key',
          resourceId: apiKeyId,
          merchantId,
          before: { status: existing.status },
          after: { status: 'REVOKED' },
          meta,
        },
        tx,
      );
      return row;
    });

    return this.toResponse(updated);
  }

  private toResponse(row: ApiKeyRow): ApiKeyResponse {
    return {
      id: row.id,
      name: row.name,
      key_prefix: row.keyPrefix,
      livemode: row.livemode,
      scopes: row.scopes,
      status: row.status,
      last_used_at: row.lastUsedAt?.toISOString() ?? null,
      created_at: row.createdAt.toISOString(),
    };
  }
}
