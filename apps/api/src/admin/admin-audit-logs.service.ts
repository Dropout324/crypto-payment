import { Inject, Injectable } from '@nestjs/common';
import type { DatabaseClient, Prisma } from '@gateway/database';
import { PRISMA_CLIENT } from '../database/prisma.module.js';
import { paginate, parseLimit } from '../common/pagination.js';
import { toAdminAuditLogResponse, type AdminAuditLogsListResponse } from './admin-audit-logs.mapper.js';

export interface ListAuditLogsFilters {
  merchantId?: string;
  actorId?: string;
  action?: string;
  resourceType?: string;
  cursor?: string;
  limit?: string;
}

/**
 * Read-only - `AuditLogService.record()` (called from inside the mutation it
 * describes) is the only writer. This exists so an admin can actually see
 * what `record()` has been writing all along; previously nothing in the API
 * surfaced the `audit_logs` table.
 *
 * Ordered newest-first, unlike `pagination.ts`'s documented ascending/cursor
 * convention every other list endpoint uses (Phase 17 pass 1, ADR 0031).
 * That convention fits an owner-scoped resource list, where the total row
 * count per caller stays small - it does not fit this endpoint, whose rows
 * accumulate globally and without bound for as long as the gateway runs.
 * Ascending order meant a filtered query (e.g. "this merchant's suspension
 * events") returned the OLDEST matching rows first once the total exceeded
 * one page, silently omitting anything recent unless the caller already
 * knew to page forward with a cursor - exactly backwards from what an
 * operator reviewing "what just happened" for an incident needs, and the
 * reproducible cause of `admin-audit-logs.e2e.test.ts`'s long-standing
 * failure (recorded as "a plausible audit-log-write race" in ADR 0025/0030
 * and left open for this phase): not a race at all, confirmed by counting
 * pre-existing matching rows in the shared dev/test database (47, exceeding
 * `DEFAULT_PAGE_LIMIT`'s 20) against the ascending page that excluded the
 * newly-written one.
 */
@Injectable()
export class AdminAuditLogsService {
  constructor(@Inject(PRISMA_CLIENT) private readonly db: DatabaseClient) {}

  async list(filters: ListAuditLogsFilters): Promise<AdminAuditLogsListResponse> {
    const limit = parseLimit(filters.limit);

    const where: Prisma.AuditLogWhereInput = {
      ...(filters.merchantId ? { merchantId: filters.merchantId } : {}),
      ...(filters.actorId ? { actorId: filters.actorId } : {}),
      ...(filters.action ? { action: filters.action } : {}),
      ...(filters.resourceType ? { resourceType: filters.resourceType } : {}),
      // `lt`, not `gt`: the cursor walks backward in time, matching the
      // `desc` order below.
      ...(filters.cursor ? { id: { lt: filters.cursor } } : {}),
    };

    const rows = await this.db.auditLog.findMany({ where, orderBy: { id: 'desc' }, take: limit + 1 });
    const { items, nextCursor } = paginate(rows, limit);
    return { audit_logs: items.map(toAdminAuditLogResponse), next_cursor: nextCursor };
  }
}
