import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { ConflictError, ErrorCode, newId } from '@gateway/shared';
import type { DatabaseClient } from '@gateway/database';
import { PRISMA_CLIENT } from '../database/prisma.module.js';

/**
 * Idempotency for mutating API calls (SPEC section 14, engineering rule #5).
 *
 * A merchant retrying a timed-out request must get back exactly the response
 * the first attempt would have produced - never a second invoice, never a
 * second charge. The contract:
 *
 *  - First call with a given (merchant, endpoint, key): the handler runs, and
 *    its outcome (status + body) is stored keyed by that triple.
 *  - Repeat call, same key, same request body: the stored response is
 *    replayed. The handler does not run again.
 *  - Repeat call, same key, DIFFERENT request body: rejected. Reusing a key
 *    for a different request is a client bug, not something to paper over.
 *  - Concurrent call with the same key while the first is still running:
 *    rejected as in-flight rather than allowed to race the first to completion.
 */
@Injectable()
export class IdempotencyService {
  constructor(@Inject(PRISMA_CLIENT) private readonly db: DatabaseClient) {}

  private hashBody(body: unknown): string {
    return createHash('sha256').update(JSON.stringify(body ?? null)).digest('hex');
  }

  /**
   * Run `handler` under idempotency protection. `key` is caller-supplied
   * (typically the `Idempotency-Key` header); `endpoint` scopes it so the same
   * key on two different endpoints does not collide.
   */
  async execute<T>(params: {
    merchantId: string;
    endpoint: string;
    key: string;
    requestBody: unknown;
    ttlMs?: number;
    handler: () => Promise<{ status: number; body: T }>;
  }): Promise<{ status: number; body: T; replayed: boolean }> {
    const { merchantId, endpoint, key, requestBody, handler } = params;
    const requestHash = this.hashBody(requestBody);
    const ttlMs = params.ttlMs ?? 24 * 60 * 60 * 1000;

    const existing = await this.db.idempotencyKey.findUnique({
      where: { merchantId_endpoint_key: { merchantId, endpoint, key } },
    });

    if (existing) {
      if (existing.requestHash !== requestHash) {
        throw new ConflictError(
          'this idempotency key was already used with a different request body',
          ErrorCode.IDEMPOTENCY_KEY_REUSED,
          { key },
        );
      }
      if (existing.completedAt) {
        return {
          status: existing.responseStatus as number,
          body: existing.responseBody as T,
          replayed: true,
        };
      }
      throw new ConflictError(
        'a request with this idempotency key is already in progress',
        ErrorCode.IDEMPOTENT_REQUEST_IN_FLIGHT,
        { key },
      );
    }

    // Claim the key. A unique constraint on (merchantId, endpoint, key) makes
    // this the race-safe step: if two requests arrive concurrently with the
    // same key, only one insert wins and the other gets IDEMPOTENT_REQUEST_IN_FLIGHT.
    try {
      await this.db.idempotencyKey.create({
        data: {
          id: newId('idempotency'),
          merchantId,
          endpoint,
          key,
          requestHash,
          lockedAt: new Date(),
          expiresAt: new Date(Date.now() + ttlMs),
        },
      });
    } catch {
      throw new ConflictError(
        'a request with this idempotency key is already in progress',
        ErrorCode.IDEMPOTENT_REQUEST_IN_FLIGHT,
        { key },
      );
    }

    let result: { status: number; body: T };
    try {
      result = await handler();
    } catch (error) {
      // The attempt genuinely failed (validation error, transient DB issue).
      // Release the lock so a retry with the same key can try again, rather
      // than being told "in progress" forever for a request that never will be.
      await this.db.idempotencyKey
        .delete({ where: { merchantId_endpoint_key: { merchantId, endpoint, key } } })
        .catch(() => {});
      throw error;
    }

    await this.db.idempotencyKey.update({
      where: { merchantId_endpoint_key: { merchantId, endpoint, key } },
      data: {
        responseStatus: result.status,
        responseBody: result.body as object,
        completedAt: new Date(),
      },
    });

    return { ...result, replayed: false };
  }
}
