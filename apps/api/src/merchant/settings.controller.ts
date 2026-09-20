import { Controller, Get, Inject, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { MerchantRoleGuard } from '../auth/merchant-role.guard.js';
import { CurrentMerchantId } from '../auth/current-merchant-id.decorator.js';
import { RateLimitGuard } from '../common/rate-limit.guard.js';
import { MerchantSettingsService } from './settings.service.js';

@Controller('v1/merchant/me/settings')
@UseGuards(JwtAuthGuard, MerchantRoleGuard, RateLimitGuard)
export class MerchantSettingsController {
  constructor(@Inject(MerchantSettingsService) private readonly settings: MerchantSettingsService) {}

  @Get()
  async get(@CurrentMerchantId() merchantId: string) {
    return this.settings.get(merchantId);
  }
}
