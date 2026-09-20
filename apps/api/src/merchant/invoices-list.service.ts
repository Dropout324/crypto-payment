import { Inject, Injectable } from '@nestjs/common';
import type { DatabaseClient, Prisma } from '@gateway/database';
import { PRISMA_CLIENT } from '../database/prisma.module.js';
import { paginate, parseLimit } from '../common/pagination.js';
import { toInvoiceResponse, type InvoiceResponse } from '../invoices/invoices.mapper.js';

export interface ListInvoicesResponse {
  invoices: InvoiceResponse[];
  next_cursor: string | null;
}

export interface ListInvoicesFilters {
  status?: string;
  cursor?: string;
  limit?: string;
}

/**
 * Dashboard-only invoice listing (`GET /v1/merchant/me/invoices`) - there is
 * no API-key-authenticated equivalent; `apps/api`'s existing invoices module
 * only ever exposed single-invoice `GET`.
 */
@Injectable()
export class InvoicesListService {
  constructor(@Inject(PRISMA_CLIENT) private readonly db: DatabaseClient) {}

  async list(merchantId: string, filters: ListInvoicesFilters): Promise<ListInvoicesResponse> {
    const limit = parseLimit(filters.limit);

    const where: Prisma.InvoiceWhereInput = {
      merchantId,
      ...(filters.status ? { status: filters.status.toUpperCase() as Prisma.InvoiceWhereInput['status'] } : {}),
      ...(filters.cursor ? { id: { gt: filters.cursor } } : {}),
    };

    const rows = await this.db.invoice.findMany({
      where,
      orderBy: { id: 'asc' },
      take: limit + 1,
      include: { paymentAddress: true },
    });

    const { items, nextCursor } = paginate(rows, limit);
    return {
      invoices: items.map((invoice) =>
        toInvoiceResponse(invoice, { paymentAddress: invoice.paymentAddress?.address ?? null, transactionHash: null }),
      ),
      next_cursor: nextCursor,
    };
  }
}
