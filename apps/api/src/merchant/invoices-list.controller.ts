import { Controller, Get, Inject, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { MerchantRoleGuard } from '../auth/merchant-role.guard.js';
import { CurrentMerchantId } from '../auth/current-merchant-id.decorator.js';
import { RateLimitGuard } from '../common/rate-limit.guard.js';
import { InvoicesListService } from './invoices-list.service.js';

@Controller('v1/merchant/me/invoices')
@UseGuards(JwtAuthGuard, MerchantRoleGuard, RateLimitGuard)
export class InvoicesListController {
  constructor(@Inject(InvoicesListService) private readonly invoices: InvoicesListService) {}

  @Get()
  async list(
    @CurrentMerchantId() merchantId: string,
    @Query('status') status?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    return this.invoices.list(merchantId, { status, cursor, limit });
  }
}
