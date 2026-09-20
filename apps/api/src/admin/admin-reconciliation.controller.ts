import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { PlatformRoleGuard } from '../auth/platform-role.guard.js';
import { PlatformPermission, RequirePlatformPermission } from '../auth/permissions.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import type { UserContext } from '../auth/auth.types.js';
import { RateLimitGuard } from '../common/rate-limit.guard.js';
import { requestAuditMeta } from '../common/audit-log.service.js';
import { AdminReconciliationService } from './admin-reconciliation.service.js';
import { ResolveDiscrepancyDto } from './admin-reconciliation.dto.js';

@Controller('v1/admin/reconciliation-discrepancies')
@UseGuards(JwtAuthGuard, PlatformRoleGuard, RateLimitGuard)
@RequirePlatformPermission(PlatformPermission.RECONCILIATION_READ)
export class AdminReconciliationController {
  constructor(@Inject(AdminReconciliationService) private readonly reconciliation: AdminReconciliationService) {}

  @Get()
  async list(@Query('severity') severity?: string, @Query('cursor') cursor?: string, @Query('limit') limit?: string) {
    return this.reconciliation.list({ severity, cursor, limit });
  }

  @Post(':id/resolve')
  @HttpCode(200)
  @RequirePlatformPermission(PlatformPermission.RECONCILIATION_RESOLVE)
  async resolve(
    @CurrentUser() user: UserContext,
    @Param('id') id: string,
    @Body() dto: ResolveDiscrepancyDto,
    @Req() request: FastifyRequest,
  ) {
    return this.reconciliation.resolve(user.userId, id, dto, requestAuditMeta(request));
  }
}
