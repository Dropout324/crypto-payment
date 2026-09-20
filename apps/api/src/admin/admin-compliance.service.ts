import { Inject, Injectable } from '@nestjs/common';
import { ConflictError, NotFoundError } from '@gateway/shared';
import { type DatabaseClient, type Prisma, runInTransaction } from '@gateway/database';
import { PRISMA_CLIENT } from '../database/prisma.module.js';
import { type AuditMeta, AuditLogService } from '../common/audit-log.service.js';
import { paginate, parseLimit } from '../common/pagination.js';
import type { ReviewComplianceCheckDto } from './admin-compliance.dto.js';
import {
  toAdminComplianceCheckResponse,
  type AdminComplianceCheckResponse,
  type AdminComplianceListResponse,
} from './admin-compliance.mapper.js';

export interface ListComplianceFilters {
  status?: string;
  cursor?: string;
  limit?: string;
}

@Injectable()
export class AdminComplianceService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly db: DatabaseClient,
    @Inject(AuditLogService) private readonly auditLog: AuditLogService,
  ) {}

  async list(filters: ListComplianceFilters): Promise<AdminComplianceListResponse> {
    const limit = parseLimit(filters.limit);

    const where: Prisma.ComplianceCheckWhereInput = {
      ...(filters.status ? { status: filters.status.toUpperCase() as Prisma.ComplianceCheckWhereInput['status'] } : {}),
      ...(filters.cursor ? { id: { gt: filters.cursor } } : {}),
    };

    const rows = await this.db.complianceCheck.findMany({ where, orderBy: { id: 'asc' }, take: limit + 1 });
    const { items, nextCursor } = paginate(rows, limit);
    return { compliance_checks: items.map(toAdminComplianceCheckResponse), next_cursor: nextCursor };
  }

  async review(
    actorUserId: string,
    checkId: string,
    dto: ReviewComplianceCheckDto,
    meta: AuditMeta,
  ): Promise<AdminComplianceCheckResponse> {
    const existing = await this.db.complianceCheck.findUnique({ where: { id: checkId } });
    if (!existing) throw new NotFoundError('compliance check', checkId);
    if (existing.status !== 'PENDING') {
      throw new ConflictError(`compliance check is already ${existing.status.toLowerCase()}`);
    }

    const status = dto.decision === 'APPROVE' ? 'PASSED' : 'FLAGGED';

    const updated = await runInTransaction(this.db, async (tx) => {
      const row = await tx.complianceCheck.update({
        where: { id: checkId },
        data: { status, reviewedBy: actorUserId, reviewedAt: new Date(), notes: dto.note ?? existing.notes },
      });
      await this.auditLog.record(
        {
          actorUserId,
          action: 'compliance_check.reviewed',
          resourceType: 'compliance_check',
          resourceId: checkId,
          before: { status: existing.status },
          after: { status, decision: dto.decision },
          metadata: dto.note ? { note: dto.note } : undefined,
          meta,
        },
        tx,
      );
      return row;
    });

    return toAdminComplianceCheckResponse(updated);
  }
}
