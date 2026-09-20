import { type CanActivate, type ExecutionContext, Inject, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ForbiddenError, UnauthenticatedError } from '@gateway/shared';
import type { FastifyRequest } from 'fastify';

export const PLATFORM_ROLE_KEY = 'requiredPlatformRoles';

/** Gates a route to one or more `User.platformRole` values. Must follow `JwtAuthGuard`. */
export const RequirePlatformRole = (...roles: string[]) => SetMetadata(PLATFORM_ROLE_KEY, roles);

/**
 * Admin-dashboard authorization (Phase 7). Runs after `JwtAuthGuard` has
 * attached `request.userContext` - applied as `@UseGuards(JwtAuthGuard,
 * PlatformRoleGuard)`, never alone.
 */
@Injectable()
export class PlatformRoleGuard implements CanActivate {
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const user = request.userContext;
    if (!user) {
      throw new UnauthenticatedError('missing session');
    }

    const required =
      this.reflector.get<string[]>(PLATFORM_ROLE_KEY, context.getHandler()) ??
      this.reflector.get<string[]>(PLATFORM_ROLE_KEY, context.getClass());

    if (!required || required.length === 0) return true;

    if (!required.includes(user.platformRole)) {
      throw new ForbiddenError('insufficient platform role');
    }

    return true;
  }
}
