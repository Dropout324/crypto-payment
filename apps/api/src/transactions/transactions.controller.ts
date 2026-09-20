import { Controller, Get, Inject, Param, Query, UseGuards } from '@nestjs/common';
import { ValidationError } from '@gateway/shared';
import { ApiKeyGuard } from '../auth/api-key.guard.js';
import { ApiKeyScope, ApiKeyScopeGuard, RequireScope } from '../auth/api-key-scope.guard.js';
import { CurrentMerchant } from '../auth/current-merchant.decorator.js';
import type { MerchantContext } from '../auth/auth.types.js';
import { RateLimitGuard } from '../common/rate-limit.guard.js';
import { TransactionsService } from './transactions.service.js';

// See the note in invoices.controller.ts: tokens are explicit because Vitest's
// esbuild transform does not emit the metadata Nest's type-based DI needs.
@Controller('v1/transactions')
@UseGuards(ApiKeyGuard, ApiKeyScopeGuard, RateLimitGuard)
@RequireScope(ApiKeyScope.TRANSACTIONS_READ)
export class TransactionsController {
  constructor(@Inject(TransactionsService) private readonly transactions: TransactionsService) {}

  @Get(':hash')
  async getByHash(
    @CurrentMerchant() merchant: MerchantContext,
    @Param('hash') hash: string,
    @Query('network') network?: string,
  ) {
    if (!network) {
      throw new ValidationError('the network query parameter is required');
    }
    return this.transactions.getByHash(merchant.merchantId, network, hash);
  }
}
