import { Controller, Get, Inject, Query, UseGuards } from '@nestjs/common';
import { ApiKeyGuard } from '../auth/api-key.guard.js';
import { ApiKeyScope, ApiKeyScopeGuard, RequireScope } from '../auth/api-key-scope.guard.js';
import { CurrentMerchant } from '../auth/current-merchant.decorator.js';
import type { MerchantContext } from '../auth/auth.types.js';
import { RateLimitGuard } from '../common/rate-limit.guard.js';
import { MerchantTransactionsService } from './merchant-transactions.service.js';

@Controller('v1/merchant/transactions')
@UseGuards(ApiKeyGuard, ApiKeyScopeGuard, RateLimitGuard)
@RequireScope(ApiKeyScope.TRANSACTIONS_READ)
export class MerchantTransactionsController {
  constructor(@Inject(MerchantTransactionsService) private readonly transactions: MerchantTransactionsService) {}

  @Get()
  async list(
    @CurrentMerchant() merchant: MerchantContext,
    @Query('network') network?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    return this.transactions.list(merchant.merchantId, { network, cursor, limit });
  }
}
