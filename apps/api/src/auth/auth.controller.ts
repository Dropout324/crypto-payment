import { Body, Controller, Get, HttpCode, Inject, Post, Req, Res, UseGuards } from '@nestjs/common';
import { UnauthenticatedError } from '@gateway/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { APP_CONFIG, type AppConfig } from '../config/env.js';
import { RateLimit, RateLimitGuard } from '../common/rate-limit.guard.js';
import { LoginDto } from './auth.dto.js';
import { AuthService } from './auth.service.js';
import { REFRESH_TOKEN_COOKIE, clearAuthCookies, setAuthCookies } from './cookies.js';
import { CurrentUser } from './current-user.decorator.js';
import type { UserContext } from './auth.types.js';
import { JwtAuthGuard } from './jwt-auth.guard.js';

// See the note in invoices.controller.ts: tokens are explicit because Vitest's
// esbuild transform does not emit the metadata Nest's type-based DI needs.
@Controller('v1/auth')
export class AuthController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Post('login')
  @HttpCode(200)
  @UseGuards(RateLimitGuard)
  @RateLimit('auth')
  async login(
    @Body() dto: LoginDto,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const result = await this.auth.login(dto.email, dto.password, {
      ip: request.ip,
      userAgent: request.headers['user-agent'] ?? null,
    });
    setAuthCookies(reply, this.config, result);
    return { user: result.user };
  }

  @Post('refresh')
  @HttpCode(200)
  @UseGuards(RateLimitGuard)
  @RateLimit('auth')
  async refresh(@Req() request: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    const presented = request.cookies?.[REFRESH_TOKEN_COOKIE];
    if (!presented) {
      throw new UnauthenticatedError('missing refresh session');
    }

    const result = await this.auth.refresh(presented, {
      ip: request.ip,
      userAgent: request.headers['user-agent'] ?? null,
    });
    setAuthCookies(reply, this.config, result);
    return { ok: true };
  }

  @Post('logout')
  @HttpCode(200)
  async logout(@Req() request: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    const presented = request.cookies?.[REFRESH_TOKEN_COOKIE];
    await this.auth.logout(presented);
    clearAuthCookies(reply);
    return { ok: true };
  }

  @Get('me')
  @UseGuards(JwtAuthGuard, RateLimitGuard)
  async me(@CurrentUser() user: UserContext) {
    return this.auth.me(user.userId);
  }
}
