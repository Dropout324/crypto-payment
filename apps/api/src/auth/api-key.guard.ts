import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { AppError, ErrorCode, ForbiddenError, UnauthenticatedError } from '@gateway/shared';
import { parseApiKey, verifyApiKeySecret } from '@gateway/security';
import type { DatabaseClient } from '@gateway/database';
import type { FastifyRequest } from 'fastify';
import { PRISMA_CLIENT } from '../database/prisma.module.js';
import type { MerchantContext } from './auth.types.js';

/**
 * API key authentication (SPEC section 15).
 *
 * `Authorization: Bearer <keyPrefix>.<secret>` - the prefix narrows to a
 * single row (cheap, indexed), and Argon2id verification runs exactly once
 * against that row's hash. A malformed header never reaches the database.
 *
 * Deliberately does NOT distinguish "unknown key" from "wrong secret" in its
 * response: both return the same 401, so the endpoint cannot be used to probe
 * which key prefixes exist.
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(@Inject(PRISMA_CLIENT) private readonly db: DatabaseClient) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const header = request.headers.authorization;

    if (!header?.startsWith('Bearer ')) {
      throw new UnauthenticatedError('missing Authorization: Bearer <api_key> header');
    }

    const parsed = parseApiKey(header.slice('Bearer '.length).trim());
    if (!parsed) {
      throw new UnauthenticatedError('malformed API key', ErrorCode.INVALID_CREDENTIALS);
    }

    const record = await this.db.apiKey.findUnique({ where: { keyPrefix: parsed.keyPrefix } });
    if (!record) {
      throw new UnauthenticatedError('invalid API key', ErrorCode.INVALID_CREDENTIALS);
    }

    if (record.status === 'REVOKED') {
      throw new UnauthenticatedError('this API key has been revoked', ErrorCode.API_KEY_REVOKED);
    }
    if (record.expiresAt && record.expiresAt.getTime() <= Date.now()) {
      throw new UnauthenticatedError('this API key has expired', ErrorCode.API_KEY_EXPIRED);
    }
    if (record.status === 'ROTATING' && record.graceExpiresAt && record.graceExpiresAt.getTime() <= Date.now()) {
      throw new UnauthenticatedError('this API key rotation grace period has ended', ErrorCode.API_KEY_EXPIRED);
    }

    const valid = await verifyApiKeySecret(parsed.secret, record.secretHash);
    if (!valid) {
      throw new UnauthenticatedError('invalid API key', ErrorCode.INVALID_CREDENTIALS);
    }

    if (record.ipAllowlist.length > 0) {
      const clientIp = request.ip;
      if (!record.ipAllowlist.includes(clientIp)) {
        throw new AppError(ErrorCode.IP_NOT_ALLOWED, 403, 'source IP is not permitted for this API key');
      }
    }

    const merchant = await this.db.merchant.findUnique({ where: { id: record.merchantId } });
    if (!merchant || merchant.status !== 'ACTIVE') {
      throw new ForbiddenError('merchant account is not active');
    }

    const merchantContext: MerchantContext = {
      merchantId: record.merchantId,
      apiKeyId: record.id,
      livemode: record.livemode,
      scopes: record.scopes,
    };
    request.merchantContext = merchantContext;

    // Best-effort usage tracking; never block the request on it.
    void this.db.apiKey
      .update({ where: { id: record.id }, data: { lastUsedAt: new Date(), lastUsedIp: request.ip } })
      .catch(() => {});

    return true;
  }
}
