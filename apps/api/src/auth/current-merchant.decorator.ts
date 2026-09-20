import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { MerchantContext } from './auth.types.js';

/** Pulls the merchant context `ApiKeyGuard` attached to the request. */
export const CurrentMerchant = createParamDecorator((_data: unknown, context: ExecutionContext): MerchantContext => {
  const request = context.switchToHttp().getRequest<FastifyRequest>();
  if (!request.merchantContext) {
    throw new Error('CurrentMerchant used on a route without ApiKeyGuard');
  }
  return request.merchantContext;
});
