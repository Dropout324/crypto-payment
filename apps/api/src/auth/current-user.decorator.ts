import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { UserContext } from './auth.types.js';

/** Pulls the user context `JwtAuthGuard` attached to the request. */
export const CurrentUser = createParamDecorator((_data: unknown, context: ExecutionContext): UserContext => {
  const request = context.switchToHttp().getRequest<FastifyRequest>();
  if (!request.userContext) {
    throw new Error('CurrentUser used on a route without JwtAuthGuard');
  }
  return request.userContext;
});
