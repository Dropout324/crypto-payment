import { Inject, Injectable } from '@nestjs/common';
import type { DatabaseClient, Prisma } from '@gateway/database';
import { PRISMA_CLIENT } from '../database/prisma.module.js';
import { paginate, parseLimit } from '../common/pagination.js';
import { toAdminSettlementResponse, type AdminSettlementsListResponse } from './admin-settlements.mapper.js';

export interface ListSettlementsFilters {
  status?: string;
  merchantId?: string;
  cursor?: string;
  limit?: string;
}

/** Read-only - creating/approving settlements is a later phase's concern (see README roadmap). */
@Injectable()
export class AdminSettlementsService {
  constructor(@Inject(PRISMA_CLIENT) private readonly db: DatabaseClient) {}

  async list(filters: ListSettlementsFilters): Promise<AdminSettlementsListResponse> {
    const limit = parseLimit(filters.limit);

    const where: Prisma.SettlementWhereInput = {
      ...(filters.status ? { status: filters.status.toUpperCase() as Prisma.SettlementWhereInput['status'] } : {}),
      ...(filters.merchantId ? { merchantId: filters.merchantId } : {}),
      ...(filters.cursor ? { id: { gt: filters.cursor } } : {}),
    };

    const rows = await this.db.settlement.findMany({ where, orderBy: { id: 'asc' }, take: limit + 1 });
    const { items, nextCursor } = paginate(rows, limit);
    return { settlements: items.map(toAdminSettlementResponse), next_cursor: nextCursor };
  }
}
