import { Controller, Get, Inject, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { MerchantRoleGuard } from '../auth/merchant-role.guard.js';
import { CurrentMerchantId } from '../auth/current-merchant-id.decorator.js';
import { RateLimitGuard } from '../common/rate-limit.guard.js';
import { BalanceService } from './balance.service.js';

/** Same `BalanceService` as the API-key-guarded `GET /v1/merchant/balance` - a second, JWT-guarded entry point for the dashboard, never duplicated logic. */
@Controller('v1/merchant/me/balance')
@UseGuards(JwtAuthGuard, MerchantRoleGuard, RateLimitGuard)
export class BalanceMeController {
  constructor(@Inject(BalanceService) private readonly balances: BalanceService) {}

  @Get()
  async get(@CurrentMerchantId() merchantId: string, @Query('network') network?: string, @Query('asset') asset?: string) {
    return this.balances.getBalances(merchantId, { network, asset });
  }
}
