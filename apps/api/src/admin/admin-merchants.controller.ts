import { Controller, Get, HttpCode, Inject, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { PlatformRoleGuard } from '../auth/platform-role.guard.js';
import { PlatformPermission, RequirePlatformPermission } from '../auth/permissions.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import type { UserContext } from '../auth/auth.types.js';
import { RateLimitGuard } from '../common/rate-limit.guard.js';
import { requestAuditMeta } from '../common/audit-log.service.js';
import { AdminMerchantsService } from './admin-merchants.service.js';

// See the note in invoices.controller.ts: tokens are explicit because Vitest's
// esbuild transform does not emit the metadata Nest's type-based DI needs.
@Controller('v1/admin/merchants')
@UseGuards(JwtAuthGuard, PlatformRoleGuard, RateLimitGuard)
@RequirePlatformPermission(PlatformPermission.MERCHANTS_READ)
export class AdminMerchantsController {
  constructor(@Inject(AdminMerchantsService) private readonly merchants: AdminMerchantsService) {}

  @Get()
  async list(@Query('status') status?: string, @Query('cursor') cursor?: string, @Query('limit') limit?: string) {
    return this.merchants.list({ status, cursor, limit });
  }

  @Get(':id')
  async get(@Param('id') id: string) {
    return this.merchants.get(id);
  }

  @Post(':id/suspend')
  @HttpCode(200)
  @RequirePlatformPermission(PlatformPermission.MERCHANTS_MANAGE)
  async suspend(@CurrentUser() user: UserContext, @Param('id') id: string, @Req() request: FastifyRequest) {
    return this.merchants.suspend(user.userId, id, requestAuditMeta(request));
  }

  @Post(':id/reactivate')
  @HttpCode(200)
  @RequirePlatformPermission(PlatformPermission.MERCHANTS_MANAGE)
  async reactivate(@CurrentUser() user: UserContext, @Param('id') id: string, @Req() request: FastifyRequest) {
    return this.merchants.reactivate(user.userId, id, requestAuditMeta(request));
  }
}
