import { Controller, Get, Inject, Query, UseGuards } from '@nestjs/common';
import { ApiKeyGuard } from '../auth/api-key.guard.js';
import { ApiKeyScope, ApiKeyScopeGuard, RequireScope } from '../auth/api-key-scope.guard.js';
import { CurrentMerchant } from '../auth/current-merchant.decorator.js';
import type { MerchantContext } from '../auth/auth.types.js';
import { RateLimitGuard } from '../common/rate-limit.guard.js';
import { BalanceService } from './balance.service.js';

@Controller('v1/merchant/balance')
@UseGuards(ApiKeyGuard, ApiKeyScopeGuard, RateLimitGuard)
@RequireScope(ApiKeyScope.BALANCE_READ)
export class BalanceController {
  constructor(@Inject(BalanceService) private readonly balances: BalanceService) {}

  @Get()
  async get(
    @CurrentMerchant() merchant: MerchantContext,
    @Query('network') network?: string,
    @Query('asset') asset?: string,
  ) {
    return this.balances.getBalances(merchant.merchantId, { network, asset });
  }
}
