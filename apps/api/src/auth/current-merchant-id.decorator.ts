import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

/**
 * Pulls the DB-verified merchant id `MerchantRoleGuard` attached to the
 * request. Deliberately a plain string, not a `MerchantContext` - dashboard
 * routes authenticate the human via `JwtAuthGuard`, not an API key, so there
 * is no `apiKeyId`/`livemode`/`scopes` to report.
 */
export const CurrentMerchantId = createParamDecorator((_data: unknown, context: ExecutionContext): string => {
  const request = context.switchToHttp().getRequest<FastifyRequest>();
  if (!request.currentMerchantId) {
    throw new Error('CurrentMerchantId used on a route without MerchantRoleGuard');
  }
  return request.currentMerchantId;
});
