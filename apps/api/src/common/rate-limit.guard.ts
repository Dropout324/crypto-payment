import { type CanActivate, type ExecutionContext, Inject, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RateLimitError } from '@gateway/shared';
import type { RateLimiter } from '@gateway/security';
import type { FastifyRequest } from 'fastify';
import { APP_CONFIG, type AppConfig } from '../config/env.js';
import { RATE_LIMITER } from './redis.module.js';

export const RATE_LIMIT_PROFILE_KEY = 'rateLimitProfile';

/** Named throttling tiers, each backed by its own `RATE_LIMIT_*_PER_MINUTE` config value. */
export type RateLimitProfile = 'api' | 'auth' | 'invoiceCreate';

/**
 * Overrides the default `'api'` profile for one route or controller. Must
 * come with `RateLimitGuard` in the same `@UseGuards(...)` list, placed
 * after any auth guard so `request.merchantContext`/`userContext` are
 * already populated when this guard reads them.
 */
export const RateLimit = (profile: RateLimitProfile) => SetMetadata(RATE_LIMIT_PROFILE_KEY, profile);

const WINDOW_SECONDS = 60;

/**
 * Abuse throttling (Phase 8), independent of `MerchantRoleGuard`/
 * `PlatformRoleGuard` authorization - this limits request *volume*, not
 * *permission*. Three profiles, each a distinct Redis bucket:
 *
 * - `'api'` (default): general per-caller ceiling. Keyed by API key when one
 *   authenticated the request, else by session user, else by IP - so a
 *   compromised/leaked API key can be throttled without the merchant's other
 *   keys or unrelated callers sharing its bucket.
 * - `'auth'`: login/refresh, keyed by IP only (there is no caller identity
 *   yet at that point) - this is the volumetric backstop behind
 *   `AuthService`'s per-account lockout, not a replacement for it.
 * - `'invoiceCreate'`: invoice creation, keyed by merchant - separated from
 *   the general `'api'` bucket because it is the one write endpoint cheap
 *   enough to spam into an address-pool exhaustion (ADR 0006).
 *
 * A rejection still counts against the window (see `RateLimiter.consume`),
 * and always throws `RateLimitError` (429) with a `retryAfterSeconds` the
 * exception filter turns into a `Retry-After` header.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    @Inject(RATE_LIMITER) private readonly limiter: RateLimiter,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(Reflector) private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const profile =
      this.reflector.get<RateLimitProfile>(RATE_LIMIT_PROFILE_KEY, context.getHandler()) ??
      this.reflector.get<RateLimitProfile>(RATE_LIMIT_PROFILE_KEY, context.getClass()) ??
      'api';

    const { limit, identity } = this.resolve(profile, request);
    const result = await this.limiter.consume(`ratelimit:${profile}:${identity}`, limit, WINDOW_SECONDS);

    if (!result.allowed) {
      throw new RateLimitError(result.retryAfterSeconds);
    }

    return true;
  }

  private resolve(profile: RateLimitProfile, request: FastifyRequest): { limit: number; identity: string } {
    switch (profile) {
      case 'auth':
        return { limit: this.config.rateLimitAuthPerMinute, identity: request.ip };
      case 'invoiceCreate':
        return {
          limit: this.config.rateLimitInvoiceCreatePerMinute,
          identity: request.merchantContext?.merchantId ?? request.ip,
        };
      case 'api':
      default:
        return {
          limit: this.config.rateLimitApiPerMinute,
          identity: request.merchantContext?.apiKeyId ?? request.userContext?.userId ?? request.ip,
        };
    }
  }
}
