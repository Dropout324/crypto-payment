import { Controller, Get, Inject, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { PlatformRoleGuard } from '../auth/platform-role.guard.js';
import { PlatformPermission, RequirePlatformPermission } from '../auth/permissions.js';
import { RateLimitGuard } from '../common/rate-limit.guard.js';
import { AdminSettlementsService } from './admin-settlements.service.js';

@Controller('v1/admin/settlements')
@UseGuards(JwtAuthGuard, PlatformRoleGuard, RateLimitGuard)
@RequirePlatformPermission(PlatformPermission.SETTLEMENTS_READ)
export class AdminSettlementsController {
  constructor(@Inject(AdminSettlementsService) private readonly settlements: AdminSettlementsService) {}

  @Get()
  async list(
    @Query('status') status?: string,
    @Query('merchant_id') merchantId?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    return this.settlements.list({ status, merchantId, cursor, limit });
  }
}
