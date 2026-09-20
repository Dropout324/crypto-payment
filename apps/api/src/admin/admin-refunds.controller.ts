import { Controller, Get, HttpCode, Inject, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { PlatformRoleGuard } from '../auth/platform-role.guard.js';
import { PlatformPermission, RequirePlatformPermission } from '../auth/permissions.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import type { UserContext } from '../auth/auth.types.js';
import { RateLimitGuard } from '../common/rate-limit.guard.js';
import { requestAuditMeta } from '../common/audit-log.service.js';
import { AdminRefundsService } from './admin-refunds.service.js';

@Controller('v1/admin/refunds')
@UseGuards(JwtAuthGuard, PlatformRoleGuard, RateLimitGuard)
@RequirePlatformPermission(PlatformPermission.REFUNDS_READ)
export class AdminRefundsController {
  constructor(@Inject(AdminRefundsService) private readonly refunds: AdminRefundsService) {}

  @Get()
  async list(@Query('status') status?: string, @Query('cursor') cursor?: string, @Query('limit') limit?: string) {
    return this.refunds.list({ status, cursor, limit });
  }

  @Post(':id/approve')
  @HttpCode(200)
  @RequirePlatformPermission(PlatformPermission.REFUNDS_DECIDE)
  async approve(@CurrentUser() user: UserContext, @Param('id') id: string, @Req() request: FastifyRequest) {
    return this.refunds.approve(user.userId, id, requestAuditMeta(request));
  }

  @Post(':id/reject')
  @HttpCode(200)
  @RequirePlatformPermission(PlatformPermission.REFUNDS_DECIDE)
  async reject(@CurrentUser() user: UserContext, @Param('id') id: string, @Req() request: FastifyRequest) {
    return this.refunds.reject(user.userId, id, requestAuditMeta(request));
  }
}
