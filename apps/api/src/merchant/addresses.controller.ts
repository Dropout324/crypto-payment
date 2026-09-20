import { Body, Controller, Get, HttpCode, Inject, Post, Query, UseGuards } from '@nestjs/common';
import { ApiKeyGuard } from '../auth/api-key.guard.js';
import { ApiKeyScope, ApiKeyScopeGuard, RequireScope } from '../auth/api-key-scope.guard.js';
import { CurrentMerchant } from '../auth/current-merchant.decorator.js';
import type { MerchantContext } from '../auth/auth.types.js';
import { RateLimitGuard } from '../common/rate-limit.guard.js';
import { AddressesService } from './addresses.service.js';
import { RegisterAddressDto } from './addresses.dto.js';

// See the note in invoices.controller.ts: tokens are explicit because Vitest's
// esbuild transform does not emit the metadata Nest's type-based DI needs.
@Controller('v1/merchant/addresses')
@UseGuards(ApiKeyGuard, ApiKeyScopeGuard, RateLimitGuard)
export class AddressesController {
  constructor(@Inject(AddressesService) private readonly addresses: AddressesService) {}

  @Post()
  @HttpCode(201)
  @RequireScope(ApiKeyScope.ADDRESSES_WRITE)
  async register(@CurrentMerchant() merchant: MerchantContext, @Body() dto: RegisterAddressDto) {
    return this.addresses.register(merchant, dto);
  }

  @Get()
  @RequireScope(ApiKeyScope.ADDRESSES_READ)
  async list(@CurrentMerchant() merchant: MerchantContext, @Query('network') network?: string) {
    return this.addresses.list(merchant, network);
  }
}
