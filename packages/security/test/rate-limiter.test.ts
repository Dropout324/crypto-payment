import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Redis } from 'ioredis';
import { RateLimiter, createRedisClient } from '../src/index.js';

/**
 * Integration test against a real Redis - same posture as the database
 * integration tests: this fails loudly if `REDIS_URL` is unreachable rather
 * than silently skipping, because a green suite that never touched Redis is
 * worse than a red one. Run `pnpm dev:infra` (or start Redis some other way)
 * before running this suite.
 */
let redis: Redis;
let limiter: RateLimiter;

beforeAll(async () => {
  redis = createRedisClient({ url: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379', db: 0 });
  await redis.connect();
  limiter = new RateLimiter(redis);
});

afterAll(async () => {
  await redis.quit();
});

function uniqueKey(): string {
  return `test:rate-limit:${randomUUID()}`;
}

describe('RateLimiter', () => {
  it('allows requests under the limit and reports remaining correctly', async () => {
    const key = uniqueKey();

    const first = await limiter.consume(key, 3, 60);
    expect(first.allowed).toBe(true);
    expect(first.remaining).toBe(2);

    const second = await limiter.consume(key, 3, 60);
    expect(second.allowed).toBe(true);
    expect(second.remaining).toBe(1);
  });

  it('blocks once the limit is exceeded, and keeps blocking rather than rolling back the count', async () => {
    const key = uniqueKey();

    await limiter.consume(key, 2, 60);
    await limiter.consume(key, 2, 60);
    const third = await limiter.consume(key, 2, 60);
    const fourth = await limiter.consume(key, 2, 60);

    expect(third.allowed).toBe(false);
    expect(third.remaining).toBe(0);
    expect(fourth.allowed).toBe(false);
  });

  it('never returns a negative remaining count', async () => {
    const key = uniqueKey();
    await limiter.consume(key, 1, 60);
    const blocked = await limiter.consume(key, 1, 60);
    expect(blocked.remaining).toBe(0);
  });

  it('reports a retryAfterSeconds bounded by the requested window', async () => {
    const key = uniqueKey();
    const result = await limiter.consume(key, 5, 30);
    expect(result.retryAfterSeconds).toBeGreaterThan(0);
    expect(result.retryAfterSeconds).toBeLessThanOrEqual(30);
  });

  it('resets after the window expires', async () => {
    const key = uniqueKey();

    await limiter.consume(key, 1, 1);
    const blocked = await limiter.consume(key, 1, 1);
    expect(blocked.allowed).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 1100));

    const afterReset = await limiter.consume(key, 1, 1);
    expect(afterReset.allowed).toBe(true);
  });

  it('keeps separate keys fully independent', async () => {
    const keyA = uniqueKey();
    const keyB = uniqueKey();

    await limiter.consume(keyA, 1, 60);
    const blockedA = await limiter.consume(keyA, 1, 60);
    const allowedB = await limiter.consume(keyB, 1, 60);

    expect(blockedA.allowed).toBe(false);
    expect(allowedB.allowed).toBe(true);
  });
});
