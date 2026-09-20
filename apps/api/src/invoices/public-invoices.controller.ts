import { Controller, Get, Inject, Param, UseGuards } from '@nestjs/common';
import { RateLimitGuard } from '../common/rate-limit.guard.js';
import { InvoicesService } from './invoices.service.js';

/**
 * The hosted payment page's backend (Phase 7) - deliberately its own
 * controller, not a method on `InvoicesController`, so no guard can ever be
 * added to `InvoicesController` and silently cover this route too (or vice
 * versa: this route must never gain `ApiKeyGuard`/`JwtAuthGuard`, since the
 * whole point is that a customer's browser, which holds neither, can call
 * it). Rate-limited by IP via the default 'api' profile - there is no caller
 * identity to key on, same posture as `AuthController`'s login/refresh.
 */
@Controller('v1/public/invoices')
@UseGuards(RateLimitGuard)
export class PublicInvoicesController {
  constructor(@Inject(InvoicesService) private readonly invoices: InvoicesService) {}

  @Get(':id')
  async get(@Param('id') id: string) {
    return this.invoices.getPublicInvoice(id);
  }
}
