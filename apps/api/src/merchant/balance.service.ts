import { Inject, Injectable } from '@nestjs/common';
import { AppError, ErrorCode, type NetworkValue, isNetwork } from '@gateway/shared';
import { type DatabaseClient, type Prisma, runInTransaction } from '@gateway/database';
import { computeAccountBalance, toMoney } from '@gateway/ledger';
import { PRISMA_CLIENT } from '../database/prisma.module.js';
import type { BalanceResponse } from './balance.mapper.js';

export interface BalanceFilters {
  network?: string;
  asset?: string;
}

@Injectable()
export class BalanceService {
  constructor(@Inject(PRISMA_CLIENT) private readonly db: DatabaseClient) {}

  /**
   * Reads every MERCHANT_PAYABLE ledger account this merchant has (what the
   * gateway currently owes them), each freshly recomputed from
   * `ledger_entries` via `computeAccountBalance` - `cached_balance` is never
   * trusted directly (SPEC section 20).
   */
  async getBalances(merchantId: string, filters: BalanceFilters): Promise<BalanceResponse> {
    const networkKey = this.parseNetworkFilter(filters.network);

    const where: Prisma.LedgerAccountWhereInput = {
      merchantId,
      isActive: true,
      type: 'LIABILITY',
      ...(networkKey ? { network: networkKey } : {}),
      ...(filters.asset ? { assetSymbol: filters.asset.toUpperCase() } : {}),
    };

    const accounts = await this.db.ledgerAccount.findMany({ where });

    const balances = await runInTransaction(this.db, async (tx) => {
      const results = [];
      for (const account of accounts) {
        const computed = await computeAccountBalance(tx, account.id);
        results.push({
          network: account.network ?? 'UNKNOWN',
          asset: account.assetSymbol,
          available: toMoney(computed).toDecimalString(),
        });
      }
      return results;
    });

    return { balances };
  }

  private parseNetworkFilter(raw: string | undefined): NetworkValue | undefined {
    if (!raw) return undefined;
    const key = raw.toUpperCase();
    if (!isNetwork(key)) {
      throw new AppError(ErrorCode.UNSUPPORTED_NETWORK, 400, `unsupported network: ${raw}`);
    }
    return key;
  }
}
