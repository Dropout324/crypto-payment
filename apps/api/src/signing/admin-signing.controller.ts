import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { PlatformRoleGuard } from '../auth/platform-role.guard.js';
import { PlatformPermission, RequirePlatformPermission } from '../auth/permissions.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import type { UserContext } from '../auth/auth.types.js';
import { RateLimitGuard } from '../common/rate-limit.guard.js';
import { AdminSigningService } from './admin-signing.service.js';
import { RejectSigningRequestDto, SigningRequestStatusQueryDto, SubmitSigningRequestDto } from './admin-signing.dto.js';

/**
 * Operator-only surface over the Phase 12 signing architecture - submit,
 * approve, reject and inspect signing requests. Not reachable by any
 * merchant-facing route, and not (yet) triggered automatically by refund or
 * settlement approval - see `AdminSigningService`'s doc comment for why.
 */
@Controller('v1/admin/signing/requests')
@UseGuards(JwtAuthGuard, PlatformRoleGuard, RateLimitGuard)
@RequirePlatformPermission(PlatformPermission.SIGNING_READ)
export class AdminSigningController {
  constructor(@Inject(AdminSigningService) private readonly signing: AdminSigningService) {}

  @Get()
  async list(@Query() query: SigningRequestStatusQueryDto) {
    return this.signing.list(query.status);
  }

  @Get(':id')
  async get(@Param('id') id: string) {
    return this.signing.get(id);
  }

  @Post()
  @HttpCode(201)
  @RequirePlatformPermission(PlatformPermission.SIGNING_DECIDE)
  async submit(@CurrentUser() user: UserContext, @Body() dto: SubmitSigningRequestDto) {
    return this.signing.submit(user.userId, dto);
  }

  @Post(':id/approve')
  @HttpCode(200)
  @RequirePlatformPermission(PlatformPermission.SIGNING_DECIDE)
  async approve(@CurrentUser() user: UserContext, @Param('id') id: string) {
    return this.signing.approve(user.userId, id);
  }

  @Post(':id/reject')
  @HttpCode(200)
  @RequirePlatformPermission(PlatformPermission.SIGNING_DECIDE)
  async reject(@CurrentUser() user: UserContext, @Param('id') id: string, @Body() dto: RejectSigningRequestDto) {
    return this.signing.reject(user.userId, id, dto.reason);
  }
}
