import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { MerchantRoleGuard } from '../auth/merchant-role.guard.js';
import { MerchantPermission, RequireMerchantPermission } from '../auth/permissions.js';
import { CurrentMerchantId } from '../auth/current-merchant-id.decorator.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import type { UserContext } from '../auth/auth.types.js';
import { RateLimitGuard } from '../common/rate-limit.guard.js';
import { requestAuditMeta } from '../common/audit-log.service.js';
import { MerchantMembersService } from './members.service.js';
import { AddMemberDto, UpdateMemberRoleDto } from './members.dto.js';

@Controller('v1/merchant/me/members')
@UseGuards(JwtAuthGuard, MerchantRoleGuard, RateLimitGuard)
export class MerchantMembersController {
  constructor(@Inject(MerchantMembersService) private readonly members: MerchantMembersService) {}

  @Get()
  @RequireMerchantPermission(MerchantPermission.MEMBERS_READ)
  async list(@CurrentMerchantId() merchantId: string) {
    return this.members.list(merchantId);
  }

  @Post()
  @HttpCode(201)
  @RequireMerchantPermission(MerchantPermission.MEMBERS_MANAGE)
  async add(
    @CurrentMerchantId() merchantId: string,
    @CurrentUser() user: UserContext,
    @Body() dto: AddMemberDto,
    @Req() request: FastifyRequest,
  ) {
    return this.members.add(merchantId, user.userId, dto, requestAuditMeta(request));
  }

  @Patch(':id')
  @RequireMerchantPermission(MerchantPermission.MEMBERS_MANAGE)
  async updateRole(
    @CurrentMerchantId() merchantId: string,
    @CurrentUser() user: UserContext,
    @Param('id') id: string,
    @Body() dto: UpdateMemberRoleDto,
    @Req() request: FastifyRequest,
  ) {
    return this.members.updateRole(merchantId, user.userId, id, dto, requestAuditMeta(request));
  }

  @Delete(':id')
  @HttpCode(204)
  @RequireMerchantPermission(MerchantPermission.MEMBERS_MANAGE)
  async remove(
    @CurrentMerchantId() merchantId: string,
    @CurrentUser() user: UserContext,
    @Param('id') id: string,
    @Req() request: FastifyRequest,
  ) {
    await this.members.remove(merchantId, user.userId, id, requestAuditMeta(request));
  }
}
