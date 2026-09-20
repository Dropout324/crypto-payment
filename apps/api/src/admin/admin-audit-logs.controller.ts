import { Controller, Get, Inject, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { PlatformRoleGuard } from '../auth/platform-role.guard.js';
import { PlatformPermission, RequirePlatformPermission } from '../auth/permissions.js';
import { RateLimitGuard } from '../common/rate-limit.guard.js';
import { AdminAuditLogsService } from './admin-audit-logs.service.js';

/**
 * Deliberately tighter than the other admin list endpoints: this is the one
 * place that shows every privileged action across every resource, including
 * ones a `SUPPORT` user should not be able to browse (who approved which
 * refund, who reviewed which compliance check). `AUDIT_LOGS_READ` is held by
 * `COMPLIANCE_OFFICER`/`ADMIN` only, not `SUPPORT` - see `permissions.ts`.
 */
@Controller('v1/admin/audit-logs')
@UseGuards(JwtAuthGuard, PlatformRoleGuard, RateLimitGuard)
@RequirePlatformPermission(PlatformPermission.AUDIT_LOGS_READ)
export class AdminAuditLogsController {
  constructor(@Inject(AdminAuditLogsService) private readonly auditLogs: AdminAuditLogsService) {}

  @Get()
  async list(
    @Query('merchant_id') merchantId?: string,
    @Query('actor_id') actorId?: string,
    @Query('action') action?: string,
    @Query('resource_type') resourceType?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    return this.auditLogs.list({ merchantId, actorId, action, resourceType, cursor, limit });
  }
}
