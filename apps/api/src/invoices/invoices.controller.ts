import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post, UseGuards } from '@nestjs/common';
import { ValidationError } from '@gateway/shared';
import { ApiKeyGuard } from '../auth/api-key.guard.js';
import { ApiKeyScope, ApiKeyScopeGuard, RequireScope } from '../auth/api-key-scope.guard.js';
import { CurrentMerchant } from '../auth/current-merchant.decorator.js';
import type { MerchantContext } from '../auth/auth.types.js';
import { IdempotencyService } from '../common/idempotency.service.js';
import { RateLimit, RateLimitGuard } from '../common/rate-limit.guard.js';
import { CancelInvoiceDto, CreateInvoiceDto } from './invoices.dto.js';
import { InvoicesService } from './invoices.service.js';

/**
 * Every constructor param below is injected via an explicit `@Inject(Class)`
 * token rather than relying on TypeScript's `design:paramtypes` reflection.
 * Nest normally infers the token from the parameter's type, but that
 * inference depends on `emitDecoratorMetadata`, which esbuild (used by
 * Vitest's default transform) does not implement - under esbuild the
 * inferred token silently resolves to `undefined` instead of throwing.
 * Explicit tokens work identically under `tsc` and `esbuild` alike.
 */
@Controller('v1/payment-invoices')
@UseGuards(ApiKeyGuard, ApiKeyScopeGuard, RateLimitGuard)
export class InvoicesController {
  constructor(
    @Inject(InvoicesService) private readonly invoices: InvoicesService,
    @Inject(IdempotencyService) private readonly idempotency: IdempotencyService,
  ) {}

  @Post()
  @HttpCode(201)
  @RateLimit('invoiceCreate')
  @RequireScope(ApiKeyScope.INVOICES_WRITE)
  async create(
    @CurrentMerchant() merchant: MerchantContext,
    @Body() dto: CreateInvoiceDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    if (!idempotencyKey) {
      throw new ValidationError('the Idempotency-Key header is required for this request');
    }

    const result = await this.idempotency.execute({
      merchantId: merchant.merchantId,
      endpoint: 'POST /v1/payment-invoices',
      key: idempotencyKey,
      requestBody: dto,
      handler: async () => ({ status: 201, body: await this.invoices.createInvoice(merchant, dto) }),
    });

    return result.body;
  }

  @Get(':id')
  @RequireScope(ApiKeyScope.INVOICES_READ)
  async get(@CurrentMerchant() merchant: MerchantContext, @Param('id') id: string) {
    return this.invoices.getInvoice(merchant, id);
  }

  @Get(':id/status')
  @RequireScope(ApiKeyScope.INVOICES_READ)
  async status(@CurrentMerchant() merchant: MerchantContext, @Param('id') id: string) {
    return this.invoices.getInvoiceStatus(merchant, id);
  }

  @Post(':id/cancel')
  @RequireScope(ApiKeyScope.INVOICES_WRITE)
  async cancel(
    @CurrentMerchant() merchant: MerchantContext,
    @Param('id') id: string,
    @Body() _dto: CancelInvoiceDto,
  ) {
    return this.invoices.cancelInvoice(merchant, id);
  }
}
