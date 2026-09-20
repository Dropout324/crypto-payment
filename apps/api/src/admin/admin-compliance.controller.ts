import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { PlatformRoleGuard } from '../auth/platform-role.guard.js';
import { PlatformPermission, RequirePlatformPermission } from '../auth/permissions.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import type { UserContext } from '../auth/auth.types.js';
import { RateLimitGuard } from '../common/rate-limit.guard.js';
import { requestAuditMeta } from '../common/audit-log.service.js';
import { AdminComplianceService } from './admin-compliance.service.js';
import { ReviewComplianceCheckDto } from './admin-compliance.dto.js';

@Controller('v1/admin/compliance-checks')
@UseGuards(JwtAuthGuard, PlatformRoleGuard, RateLimitGuard)
@RequirePlatformPermission(PlatformPermission.COMPLIANCE_READ)
export class AdminComplianceController {
  constructor(@Inject(AdminComplianceService) private readonly compliance: AdminComplianceService) {}

  @Get()
  async list(@Query('status') status?: string, @Query('cursor') cursor?: string, @Query('limit') limit?: string) {
    return this.compliance.list({ status, cursor, limit });
  }

  @Post(':id/review')
  @HttpCode(200)
  @RequirePlatformPermission(PlatformPermission.COMPLIANCE_REVIEW)
  async review(
    @CurrentUser() user: UserContext,
    @Param('id') id: string,
    @Body() dto: ReviewComplianceCheckDto,
    @Req() request: FastifyRequest,
  ) {
    return this.compliance.review(user.userId, id, dto, requestAuditMeta(request));
  }
}
