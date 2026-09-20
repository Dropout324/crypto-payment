import { Inject, Injectable } from '@nestjs/common';
import { ConflictError, NotFoundError } from '@gateway/shared';
import { type DatabaseClient, type Prisma, runInTransaction } from '@gateway/database';
import { PRISMA_CLIENT } from '../database/prisma.module.js';
import { type AuditMeta, AuditLogService } from '../common/audit-log.service.js';
import { paginate, parseLimit } from '../common/pagination.js';
import type { ResolveDiscrepancyDto } from './admin-reconciliation.dto.js';
import {
  toAdminDiscrepancyResponse,
  type AdminDiscrepanciesListResponse,
  type AdminDiscrepancyResponse,
} from './admin-reconciliation.mapper.js';

export interface ListDiscrepanciesFilters {
  severity?: string;
  cursor?: string;
  limit?: string;
}

/**
 * Read/resolve access only - this deliberately never triggers
 * `runLedgerReconciliation()` itself (that stays the worker/scheduler's job,
 * see README). A discrepancy is never auto-resolved (SPEC section 21); only
 * an explicit admin action closes one, and the resolution is itself recorded.
 */
@Injectable()
export class AdminReconciliationService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly db: DatabaseClient,
    @Inject(AuditLogService) private readonly auditLog: AuditLogService,
  ) {}

  async list(filters: ListDiscrepanciesFilters): Promise<AdminDiscrepanciesListResponse> {
    const limit = parseLimit(filters.limit);

    const where: Prisma.ReconciliationDiscrepancyWhereInput = {
      ...(filters.severity ? { severity: filters.severity.toUpperCase() as Prisma.ReconciliationDiscrepancyWhereInput['severity'] } : {}),
      ...(filters.cursor ? { id: { gt: filters.cursor } } : {}),
    };

    const rows = await this.db.reconciliationDiscrepancy.findMany({ where, orderBy: { id: 'asc' }, take: limit + 1 });
    const { items, nextCursor } = paginate(rows, limit);
    return { discrepancies: items.map(toAdminDiscrepancyResponse), next_cursor: nextCursor };
  }

  async resolve(
    actorUserId: string,
    discrepancyId: string,
    dto: ResolveDiscrepancyDto,
    meta: AuditMeta,
  ): Promise<AdminDiscrepancyResponse> {
    const existing = await this.db.reconciliationDiscrepancy.findUnique({ where: { id: discrepancyId } });
    if (!existing) throw new NotFoundError('reconciliation discrepancy', discrepancyId);
    if (existing.resolvedAt) {
      throw new ConflictError('discrepancy is already resolved');
    }

    const updated = await runInTransaction(this.db, async (tx) => {
      const row = await tx.reconciliationDiscrepancy.update({
        where: { id: discrepancyId },
        data: { resolvedBy: actorUserId, resolvedAt: new Date(), resolutionNote: dto.resolution_note },
      });
      await this.auditLog.record(
        {
          actorUserId,
          action: 'reconciliation_discrepancy.resolved',
          resourceType: 'reconciliation_discrepancy',
          resourceId: discrepancyId,
          metadata: { resolution_note: dto.resolution_note },
          meta,
        },
        tx,
      );
      return row;
    });

    return toAdminDiscrepancyResponse(updated);
  }
}
