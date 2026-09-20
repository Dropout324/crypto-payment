import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { MerchantRoleGuard } from '../auth/merchant-role.guard.js';
import { MerchantPermission, RequireMerchantPermission } from '../auth/permissions.js';
import { CurrentMerchantId } from '../auth/current-merchant-id.decorator.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import type { UserContext } from '../auth/auth.types.js';
import { RateLimitGuard } from '../common/rate-limit.guard.js';
import { requestAuditMeta } from '../common/audit-log.service.js';
import { WebhookEndpointsService } from './webhook-endpoints.service.js';
import { CreateWebhookEndpointDto, UpdateWebhookEndpointDto } from './webhook-endpoints.dto.js';
import { WebhooksTestService } from '../webhooks/webhooks-test.service.js';

// See the note in invoices.controller.ts: tokens are explicit because Vitest's
// esbuild transform does not emit the metadata Nest's type-based DI needs.
@Controller('v1/merchant/me/webhook-endpoints')
@UseGuards(JwtAuthGuard, MerchantRoleGuard, RateLimitGuard)
export class WebhookEndpointsController {
  constructor(
    @Inject(WebhookEndpointsService) private readonly endpoints: WebhookEndpointsService,
    @Inject(WebhooksTestService) private readonly webhooksTest: WebhooksTestService,
  ) {}

  @Get()
  async list(@CurrentMerchantId() merchantId: string) {
    return this.endpoints.list(merchantId);
  }

  @Post()
  @HttpCode(201)
  @RequireMerchantPermission(MerchantPermission.WEBHOOKS_MANAGE)
  async create(
    @CurrentMerchantId() merchantId: string,
    @CurrentUser() user: UserContext,
    @Body() dto: CreateWebhookEndpointDto,
    @Req() request: FastifyRequest,
  ) {
    return this.endpoints.create(merchantId, user.userId, dto, requestAuditMeta(request));
  }

  @Patch(':id')
  @RequireMerchantPermission(MerchantPermission.WEBHOOKS_MANAGE)
  async update(
    @CurrentMerchantId() merchantId: string,
    @CurrentUser() user: UserContext,
    @Param('id') id: string,
    @Body() dto: UpdateWebhookEndpointDto,
    @Req() request: FastifyRequest,
  ) {
    return this.endpoints.update(merchantId, user.userId, id, dto, requestAuditMeta(request));
  }

  @Post(':id/rotate-secret')
  @RequireMerchantPermission(MerchantPermission.WEBHOOKS_MANAGE)
  async rotateSecret(
    @CurrentMerchantId() merchantId: string,
    @CurrentUser() user: UserContext,
    @Param('id') id: string,
    @Req() request: FastifyRequest,
  ) {
    return this.endpoints.rotateSecret(merchantId, user.userId, id, requestAuditMeta(request));
  }

  /** Same synchronous test-send `POST /v1/webhooks/test` uses (see webhooks-test.service.ts) - one service, two guarded entry points. */
  @Post(':id/test')
  @HttpCode(200)
  async test(@CurrentMerchantId() merchantId: string, @Param('id') id: string) {
    return this.webhooksTest.sendTestEvent(merchantId, id);
  }
}
