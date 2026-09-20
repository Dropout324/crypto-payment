import type { FastifyReply } from 'fastify';
import type { AppConfig } from '../config/env.js';

/**
 * Cookie names for the dashboard session (Phase 7).
 *
 * The access token is a short-lived JWT verified statelessly by
 * `JwtAuthGuard`. The refresh token is an opaque value whose hash lives in
 * `Session`; it is scoped to `/v1/auth` so it is never sent on ordinary API
 * calls, only to the login/refresh/logout endpoints that need it.
 */
export const ACCESS_TOKEN_COOKIE = 'gw_access';
export const REFRESH_TOKEN_COOKIE = 'gw_refresh';

export function setAuthCookies(
  reply: FastifyReply,
  config: AppConfig,
  tokens: { accessToken: string; refreshToken: string },
): void {
  const secure = config.nodeEnv === 'production';

  reply.setCookie(ACCESS_TOKEN_COOKIE, tokens.accessToken, {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    path: '/',
    maxAge: config.jwtAccessTtlSeconds,
  });

  reply.setCookie(REFRESH_TOKEN_COOKIE, tokens.refreshToken, {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    path: '/v1/auth',
    maxAge: config.jwtRefreshTtlSeconds,
  });
}

export function clearAuthCookies(reply: FastifyReply): void {
  reply.clearCookie(ACCESS_TOKEN_COOKIE, { path: '/' });
  reply.clearCookie(REFRESH_TOKEN_COOKIE, { path: '/v1/auth' });
}
