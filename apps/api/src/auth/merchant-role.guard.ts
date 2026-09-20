import { type CanActivate, type ExecutionContext, Inject, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ForbiddenError, UnauthenticatedError, ValidationError } from '@gateway/shared';
import type { DatabaseClient } from '@gateway/database';
import type { FastifyRequest } from 'fastify';
import { PRISMA_CLIENT } from '../database/prisma.module.js';

export const MERCHANT_ROLE_KEY = 'requiredMerchantRoles';
export const MERCHANT_ID_HEADER = 'x-merchant-id';

/** Gates a route to one or more `MerchantMember.role` values. Must follow `JwtAuthGuard`. */
export const RequireMerchantRole = (...roles: string[]) => SetMetadata(MERCHANT_ROLE_KEY, roles);

/**
 * Merchant-dashboard authorization (Phase 7).
 *
 * A logged-in user's memberships are never baked into the access JWT (they
 * can change without forcing re-login), so the dashboard sends its currently
 * selected merchant as the `X-Merchant-Id` header and this guard re-checks
 * `MerchantMember` against it on every request - the header is never trusted
 * on its own. Runs after `JwtAuthGuard`, applied as
 * `@UseGuards(JwtAuthGuard, MerchantRoleGuard)`.
 */
@Injectable()
export class MerchantRoleGuard implements CanActivate {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly db: DatabaseClient,
    @Inject(Reflector) private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const user = request.userContext;
    if (!user) {
      throw new UnauthenticatedError('missing session');
    }

    const header = request.headers[MERCHANT_ID_HEADER];
    const merchantId = Array.isArray(header) ? header[0] : header;
    if (!merchantId) {
      throw new ValidationError(`the ${MERCHANT_ID_HEADER} header is required`);
    }

    const membership = await this.db.merchantMember.findUnique({
      where: { merchantId_userId: { merchantId, userId: user.userId } },
      include: { merchant: { select: { status: true } } },
    });
    if (!membership) {
      throw new ForbiddenError('you are not a member of this merchant');
    }

    // Phase 17 pass 1: unlike `ApiKeyGuard` (which already re-checks
    // `merchant.status` on every request), this guard used to trust the
    // membership row alone - a suspended merchant's dashboard users kept
    // full access for the rest of their access-token TTL, and indefinitely
    // for as long as they kept refreshing, since nothing here ever looked at
    // `merchant.status`. Checked live on every request (this guard already
    // does a DB round trip for the membership row, so this adds no new
    // query), suspension now takes effect on the very next dashboard
    // request - no TTL window at all, unlike the JWT-access-token exposure
    // documented in ADR 0031 for user-level suspension.
    if (membership.merchant.status !== 'ACTIVE') {
      throw new ForbiddenError('this merchant account is not active');
    }

    const required =
      this.reflector.get<string[]>(MERCHANT_ROLE_KEY, context.getHandler()) ??
      this.reflector.get<string[]>(MERCHANT_ROLE_KEY, context.getClass());

    if (required && required.length > 0 && !required.includes(membership.role)) {
      throw new ForbiddenError('insufficient merchant role');
    }

    request.currentMerchantId = merchantId;
    request.currentMerchantRole = membership.role;

    return true;
  }
}
