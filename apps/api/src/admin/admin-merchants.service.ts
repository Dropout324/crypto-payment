import { Inject, Injectable } from '@nestjs/common';
import { ConflictError, NotFoundError } from '@gateway/shared';
import { type DatabaseClient, type Prisma, runInTransaction } from '@gateway/database';
import { PRISMA_CLIENT } from '../database/prisma.module.js';
import { type AuditMeta, AuditLogService } from '../common/audit-log.service.js';
import { paginate, parseLimit } from '../common/pagination.js';
import { toAdminMerchantResponse, type AdminMerchantResponse, type AdminMerchantsListResponse } from './admin-merchants.mapper.js';

export interface ListMerchantsFilters {
  status?: string;
  cursor?: string;
  limit?: string;
}

@Injectable()
export class AdminMerchantsService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly db: DatabaseClient,
    @Inject(AuditLogService) private readonly auditLog: AuditLogService,
  ) {}

  async list(filters: ListMerchantsFilters): Promise<AdminMerchantsListResponse> {
    const limit = parseLimit(filters.limit);

    const where: Prisma.MerchantWhereInput = {
      ...(filters.status ? { status: filters.status.toUpperCase() as Prisma.MerchantWhereInput['status'] } : {}),
      ...(filters.cursor ? { id: { gt: filters.cursor } } : {}),
    };

    const rows = await this.db.merchant.findMany({ where, orderBy: { id: 'asc' }, take: limit + 1 });
    const { items, nextCursor } = paginate(rows, limit);
    return { merchants: items.map(toAdminMerchantResponse), next_cursor: nextCursor };
  }

  async get(merchantId: string): Promise<AdminMerchantResponse> {
    const merchant = await this.db.merchant.findUnique({ where: { id: merchantId } });
    if (!merchant) throw new NotFoundError('merchant', merchantId);
    return toAdminMerchantResponse(merchant);
  }

  async suspend(actorUserId: string, merchantId: string, meta: AuditMeta): Promise<AdminMerchantResponse> {
    return this.transition(actorUserId, merchantId, 'SUSPENDED', 'merchant.suspended', meta);
  }

  async reactivate(actorUserId: string, merchantId: string, meta: AuditMeta): Promise<AdminMerchantResponse> {
    return this.transition(actorUserId, merchantId, 'ACTIVE', 'merchant.reactivated', meta);
  }

  private async transition(
    actorUserId: string,
    merchantId: string,
    status: 'SUSPENDED' | 'ACTIVE',
    action: string,
    meta: AuditMeta,
  ): Promise<AdminMerchantResponse> {
    const existing = await this.db.merchant.findUnique({ where: { id: merchantId } });
    if (!existing) throw new NotFoundError('merchant', merchantId);
    if (existing.status === status) {
      throw new ConflictError(`merchant is already ${status.toLowerCase()}`);
    }

    const updated = await runInTransaction(this.db, async (tx) => {
      const row = await tx.merchant.update({ where: { id: merchantId }, data: { status } });
      await this.auditLog.record(
        {
          actorUserId,
          action,
          resourceType: 'merchant',
          resourceId: merchantId,
          merchantId,
          before: { status: existing.status },
          after: { status },
          meta,
        },
        tx,
      );
      return row;
    });

    return toAdminMerchantResponse(updated);
  }
}
