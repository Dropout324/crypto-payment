import { Controller, Get, Inject, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { MerchantRoleGuard } from '../auth/merchant-role.guard.js';
import { CurrentMerchantId } from '../auth/current-merchant-id.decorator.js';
import { RateLimitGuard } from '../common/rate-limit.guard.js';
import { MerchantTransactionsService } from './merchant-transactions.service.js';

/** Same `MerchantTransactionsService` as the API-key-guarded `GET /v1/merchant/transactions` - a second, JWT-guarded entry point for the dashboard. */
@Controller('v1/merchant/me/transactions')
@UseGuards(JwtAuthGuard, MerchantRoleGuard, RateLimitGuard)
export class TransactionsMeController {
  constructor(@Inject(MerchantTransactionsService) private readonly transactions: MerchantTransactionsService) {}

  @Get()
  async list(
    @CurrentMerchantId() merchantId: string,
    @Query('network') network?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    return this.transactions.list(merchantId, { network, cursor, limit });
  }
}
