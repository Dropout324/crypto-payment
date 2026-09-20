import { Inject, Injectable } from '@nestjs/common';
import { ValidationError, type NetworkValue, isNetwork } from '@gateway/shared';
import type { DatabaseClient, Prisma } from '@gateway/database';
import { PRISMA_CLIENT } from '../database/prisma.module.js';
import { paginate, parseLimit } from '../common/pagination.js';
import { toMerchantTransferResponse, type MerchantTransactionsResponse } from './merchant-transactions.mapper.js';

export interface ListTransactionsFilters {
  network?: string;
  cursor?: string;
  limit?: string;
}

@Injectable()
export class MerchantTransactionsService {
  constructor(@Inject(PRISMA_CLIENT) private readonly db: DatabaseClient) {}

  async list(merchantId: string, filters: ListTransactionsFilters): Promise<MerchantTransactionsResponse> {
    const limit = parseLimit(filters.limit);
    const networkKey = this.parseNetworkFilter(filters.network);

    const where: Prisma.TokenTransferWhereInput = {
      OR: [{ paymentAddress: { merchantId } }, { invoice: { merchantId } }],
      ...(networkKey ? { network: networkKey } : {}),
      ...(filters.cursor ? { id: { gt: filters.cursor } } : {}),
    };

    const rows = await this.db.tokenTransfer.findMany({
      where,
      orderBy: { id: 'asc' },
      take: limit + 1,
    });

    const { items, nextCursor } = paginate(rows, limit);
    return { transactions: items.map(toMerchantTransferResponse), next_cursor: nextCursor };
  }

  private parseNetworkFilter(raw: string | undefined): NetworkValue | undefined {
    if (!raw) return undefined;
    const key = raw.toUpperCase();
    if (!isNetwork(key)) {
      throw new ValidationError(`unsupported network: ${raw}`);
    }
    return key;
  }
}
