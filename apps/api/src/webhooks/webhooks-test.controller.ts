import { Body, Controller, HttpCode, Inject, Post, UseGuards } from '@nestjs/common';
import { ApiKeyGuard } from '../auth/api-key.guard.js';
import { ApiKeyScope, ApiKeyScopeGuard, RequireScope } from '../auth/api-key-scope.guard.js';
import { CurrentMerchant } from '../auth/current-merchant.decorator.js';
import type { MerchantContext } from '../auth/auth.types.js';
import { RateLimitGuard } from '../common/rate-limit.guard.js';
import { TestWebhookDto } from './webhooks-test.dto.js';
import { WebhooksTestService } from './webhooks-test.service.js';

@Controller('v1/webhooks')
@UseGuards(ApiKeyGuard, ApiKeyScopeGuard, RateLimitGuard)
export class WebhooksTestController {
  constructor(@Inject(WebhooksTestService) private readonly webhooksTest: WebhooksTestService) {}

  @Post('test')
  @HttpCode(200)
  @RequireScope(ApiKeyScope.WEBHOOKS_WRITE)
  async test(@CurrentMerchant() merchant: MerchantContext, @Body() dto: TestWebhookDto) {
    return this.webhooksTest.sendTestEvent(merchant.merchantId, dto.endpoint_id);
  }
}
