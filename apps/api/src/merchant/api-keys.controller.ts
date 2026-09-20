import { Body, Controller, Get, HttpCode, Inject, Param, Post, Req, UseGuards } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { MerchantRoleGuard } from '../auth/merchant-role.guard.js';
import { MerchantPermission, RequireMerchantPermission } from '../auth/permissions.js';
import { CurrentMerchantId } from '../auth/current-merchant-id.decorator.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import type { UserContext } from '../auth/auth.types.js';
import { RateLimitGuard } from '../common/rate-limit.guard.js';
import { requestAuditMeta } from '../common/audit-log.service.js';
import { ApiKeysService } from './api-keys.service.js';
import { CreateApiKeyDto } from './api-keys.dto.js';

// See the note in invoices.controller.ts: tokens are explicit because Vitest's
// esbuild transform does not emit the metadata Nest's type-based DI needs.
@Controller('v1/merchant/me/api-keys')
@UseGuards(JwtAuthGuard, MerchantRoleGuard, RateLimitGuard)
export class ApiKeysController {
  constructor(@Inject(ApiKeysService) private readonly apiKeys: ApiKeysService) {}

  @Get()
  async list(@CurrentMerchantId() merchantId: string) {
    return this.apiKeys.list(merchantId);
  }

  @Post()
  @HttpCode(201)
  @RequireMerchantPermission(MerchantPermission.API_KEYS_MANAGE)
  async create(
    @CurrentMerchantId() merchantId: string,
    @CurrentUser() user: UserContext,
    @Body() dto: CreateApiKeyDto,
    @Req() request: FastifyRequest,
  ) {
    return this.apiKeys.create(merchantId, user.userId, dto, requestAuditMeta(request));
  }

  @Post(':id/revoke')
  @RequireMerchantPermission(MerchantPermission.API_KEYS_MANAGE)
  async revoke(
    @CurrentMerchantId() merchantId: string,
    @CurrentUser() user: UserContext,
    @Param('id') id: string,
    @Req() request: FastifyRequest,
  ) {
    return this.apiKeys.revoke(merchantId, user.userId, id, requestAuditMeta(request));
  }
}
