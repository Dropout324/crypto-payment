import type { DatabaseClient } from '@gateway/database';
import { createPrismaClient } from '@gateway/database';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from './support/create-test-app.js';
import { seedUser } from './support/seed-user.js';

/**
 * `setup-env.ts` sets every `RATE_LIMIT_*_PER_MINUTE` to an effectively
 * unlimited value so the rest of the e2e suite (which all shares one
 * loopback-IP identity against one real Redis) never trips over the
 * default-strict `RATE_LIMIT_AUTH_PER_MINUTE=10`. This file is the one place
 * that turns a real, small limit back on - via `APP_CONFIG` override on its
 * own app instance - to prove `RateLimitGuard` actually rejects with 429
 * end-to-end, not just at the unit level.
 *
 * `trustProxy: true` plus a synthetic `X-Forwarded-For` per test gives each
 * case its own rate-limit identity, so this suite cannot collide with
 * itself across test cases, or with every other e2e file hammering
 * `/v1/auth/login` from the real loopback address on the same Redis.
 */
const AUTH_LIMIT = 3;

let testApp: TestApp;
let db: DatabaseClient;

beforeAll(async () => {
  testApp = await createTestApp({ configOverrides: { rateLimitAuthPerMinute: AUTH_LIMIT }, trustProxy: true });
  db = createPrismaClient();
  await db.$connect();
});

afterAll(async () => {
  await testApp.close();
  await db.$disconnect();
});

function server() {
  return request(testApp.app.getHttpServer());
}

function syntheticIp(): string {
  const a = Math.floor(Math.random() * 200) + 10;
  const b = Math.floor(Math.random() * 200) + 10;
  return `10.${a}.${b}.1`;
}

describe('rate limiting (auth profile)', () => {
  it('allows requests up to the configured limit, then rejects with 429 and Retry-After', async () => {
    const ip = syntheticIp();
    const user = await seedUser(db);

    for (let i = 0; i < AUTH_LIMIT; i++) {
      const response = await server()
        .post('/v1/auth/login')
        .set('X-Forwarded-For', ip)
        .send({ email: user.email, password: 'wrong-password' });
      expect(response.status).not.toBe(429);
    }

    const blocked = await server()
      .post('/v1/auth/login')
      .set('X-Forwarded-For', ip)
      .send({ email: user.email, password: 'wrong-password' });

    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('rate_limited');
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('keeps separate client IPs on independent buckets', async () => {
    const throttledIp = syntheticIp();
    const freshIp = syntheticIp();
    const user = await seedUser(db);

    for (let i = 0; i < AUTH_LIMIT; i++) {
      await server()
        .post('/v1/auth/login')
        .set('X-Forwarded-For', throttledIp)
        .send({ email: user.email, password: 'wrong-password' });
    }
    const blocked = await server()
      .post('/v1/auth/login')
      .set('X-Forwarded-For', throttledIp)
      .send({ email: user.email, password: 'wrong-password' });
    expect(blocked.status).toBe(429);

    const fromFreshIp = await server()
      .post('/v1/auth/login')
      .set('X-Forwarded-For', freshIp)
      .send({ email: user.email, password: 'wrong-password' });
    expect(fromFreshIp.status).not.toBe(429);
  });
});
