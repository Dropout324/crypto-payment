import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { UnauthenticatedError } from '@gateway/shared';
import { verifyJwt } from '@gateway/security';
import type { FastifyRequest } from 'fastify';
import { APP_CONFIG, type AppConfig } from '../config/env.js';
import { ACCESS_TOKEN_COOKIE } from './cookies.js';
import type { UserContext } from './auth.types.js';

interface AccessTokenClaims extends Record<string, unknown> {
  sub: string;
  email: string;
  platform_role: string;
}

/**
 * Dashboard session authentication (Phase 7).
 *
 * Verifies the `gw_access` httpOnly cookie as a stateless HS256 JWT - no
 * database lookup, unlike `ApiKeyGuard`. Deliberately does not distinguish
 * "missing cookie" from "expired" from "tampered" in the response: all three
 * return the same 401, mirroring `ApiKeyGuard`'s posture on unknown vs wrong
 * API keys.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const token = request.cookies?.[ACCESS_TOKEN_COOKIE];
    if (!token) {
      throw new UnauthenticatedError('missing session');
    }

    let claims: AccessTokenClaims;
    try {
      claims = verifyJwt<AccessTokenClaims>(token, this.config.jwtAccessSecret, {
        issuer: this.config.jwtIssuer,
        audience: this.config.jwtAudience,
      });
    } catch {
      throw new UnauthenticatedError('invalid or expired session');
    }

    const userContext: UserContext = {
      userId: claims.sub,
      email: claims.email,
      platformRole: claims.platform_role,
    };
    request.userContext = userContext;

    return true;
  }
}
