import { Inject, Injectable } from '@nestjs/common';
import { ConflictError, NotFoundError } from '@gateway/shared';
import { type DatabaseClient, type Prisma, runInTransaction } from '@gateway/database';
import { PRISMA_CLIENT } from '../database/prisma.module.js';
import { type AuditMeta, AuditLogService } from '../common/audit-log.service.js';
import { paginate, parseLimit } from '../common/pagination.js';
import { toAdminRefundResponse, type AdminRefundResponse, type AdminRefundsListResponse } from './admin-refunds.mapper.js';

export interface ListRefundsFilters {
  status?: string;
  cursor?: string;
  limit?: string;
}

/**
 * A `Refund`'s status is its own simple field, not driven by
 * `packages/payments`'s invoice state machine (that package only governs
 * `InvoiceStatus`) - approval here is a plain
 * `REQUESTED|COMPLIANCE_REVIEW -> APPROVED|REJECTED` check, not a second
 * state-machine table.
 */
const APPROVABLE_STATUSES = new Set(['REQUESTED', 'COMPLIANCE_REVIEW']);

@Injectable()
export class AdminRefundsService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly db: DatabaseClient,
    @Inject(AuditLogService) private readonly auditLog: AuditLogService,
  ) {}

  async list(filters: ListRefundsFilters): Promise<AdminRefundsListResponse> {
    const limit = parseLimit(filters.limit);

    const where: Prisma.RefundWhereInput = {
      ...(filters.status ? { status: filters.status.toUpperCase() as Prisma.RefundWhereInput['status'] } : {}),
      ...(filters.cursor ? { id: { gt: filters.cursor } } : {}),
    };

    const rows = await this.db.refund.findMany({ where, orderBy: { id: 'asc' }, take: limit + 1 });
    const { items, nextCursor } = paginate(rows, limit);
    return { refunds: items.map(toAdminRefundResponse), next_cursor: nextCursor };
  }

  async approve(actorUserId: string, refundId: string, meta: AuditMeta): Promise<AdminRefundResponse> {
    return this.decide(actorUserId, refundId, 'APPROVED', meta);
  }

  async reject(actorUserId: string, refundId: string, meta: AuditMeta): Promise<AdminRefundResponse> {
    return this.decide(actorUserId, refundId, 'REJECTED', meta);
  }

  private async decide(
    actorUserId: string,
    refundId: string,
    target: 'APPROVED' | 'REJECTED',
    meta: AuditMeta,
  ): Promise<AdminRefundResponse> {
    const existing = await this.db.refund.findUnique({ where: { id: refundId } });
    if (!existing) throw new NotFoundError('refund', refundId);
    if (!APPROVABLE_STATUSES.has(existing.status)) {
      throw new ConflictError(`refund cannot be decided from status ${existing.status}`);
    }

    const updated = await runInTransaction(this.db, async (tx) => {
      const row = await tx.refund.update({
        where: { id: refundId },
        data:
          target === 'APPROVED'
            ? { status: 'APPROVED', approvedBy: actorUserId, approvedAt: new Date() }
            : { status: 'REJECTED', rejectedBy: actorUserId, rejectedAt: new Date() },
      });
      await this.auditLog.record(
        {
          actorUserId,
          action: target === 'APPROVED' ? 'refund.approved' : 'refund.rejected',
          resourceType: 'refund',
          resourceId: refundId,
          merchantId: existing.merchantId,
          before: { status: existing.status },
          after: { status: target },
          meta,
        },
        tx,
      );
      return row;
    });

    return toAdminRefundResponse(updated);
  }
}
