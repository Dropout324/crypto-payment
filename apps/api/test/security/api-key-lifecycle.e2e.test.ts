import type { DatabaseClient } from '@gateway/database';
import { createPrismaClient } from '@gateway/database';
import { generateApiKey } from '@gateway/security';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../support/create-test-app.js';
import { seedMerchant } from '../support/seed-merchant.js';

/**
 * `ApiKeyGuard` (apps/api/src/auth/api-key.guard.ts) has several rejection
 * branches - revoked, expired, mid-rotation past grace, IP-allowlisted,
 * inactive merchant - that no e2e test exercised end-to-end before this file:
 * every existing suite only ever hits the "valid key" and "malformed bearer"
 * paths. A regression that quietly disabled one of these checks (e.g. an
 * early return skipping the `status === 'REVOKED'` branch) would have shipped
 * unnoticed.
 */

let testApp: TestApp;
let db: DatabaseClient;

beforeAll(async () => {
  testApp = await createTestApp({ trustProxy: true });
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

/** Any route behind `ApiKeyGuard`; a 404 from the service still proves the guard let the request through. */
async function probeWithKey(plaintext: string, forwardedFor?: string) {
  const req = server().get('/v1/payment-invoices/nonexistent-id').set('Authorization', `Bearer ${plaintext}`);
  if (forwardedFor) req.set('X-Forwarded-For', forwardedFor);
  return req.send();
}

describe('ApiKeyGuard lifecycle enforcement', () => {
  it('rejects a revoked key even with the correct secret', async () => {
    const merchant = await seedMerchant(db);
    await db.apiKey.updateMany({ where: { merchantId: merchant.merchantId }, data: { status: 'REVOKED' } });

    const response = await probeWithKey(merchant.apiKeyPlaintext);
    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('api_key_revoked');
  });

  it('rejects a key past its expiresAt', async () => {
    const merchant = await seedMerchant(db);
    await db.apiKey.updateMany({
      where: { merchantId: merchant.merchantId },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });

    const response = await probeWithKey(merchant.apiKeyPlaintext);
    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('api_key_expired');
  });

  it('rejects a rotating key once its grace period has ended', async () => {
    const merchant = await seedMerchant(db);
    await db.apiKey.updateMany({
      where: { merchantId: merchant.merchantId },
      data: { status: 'ROTATING', graceExpiresAt: new Date(Date.now() - 60_000) },
    });

    const response = await probeWithKey(merchant.apiKeyPlaintext);
    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('api_key_expired');
  });

  it('still accepts a rotating key while inside its grace period', async () => {
    const merchant = await seedMerchant(db);
    await db.apiKey.updateMany({
      where: { merchantId: merchant.merchantId },
      data: { status: 'ROTATING', graceExpiresAt: new Date(Date.now() + 60_000) },
    });

    const response = await probeWithKey(merchant.apiKeyPlaintext);
    expect(response.status).toBe(404); // guard passed; service 404s on the fake invoice id
  });

  it('rejects a request whose source IP is outside the key\'s allowlist', async () => {
    const merchant = await seedMerchant(db);
    await db.apiKey.updateMany({
      where: { merchantId: merchant.merchantId },
      data: { ipAllowlist: ['203.0.113.9'] },
    });

    const response = await probeWithKey(merchant.apiKeyPlaintext, '198.51.100.5');
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('ip_not_allowed');
  });

  it('accepts a request whose source IP is in the allowlist', async () => {
    const merchant = await seedMerchant(db);
    await db.apiKey.updateMany({
      where: { merchantId: merchant.merchantId },
      data: { ipAllowlist: ['198.51.100.5'] },
    });

    const response = await probeWithKey(merchant.apiKeyPlaintext, '198.51.100.5');
    expect(response.status).toBe(404); // guard passed
  });

  it('rejects a key belonging to a suspended merchant', async () => {
    const merchant = await seedMerchant(db);
    await db.merchant.update({ where: { id: merchant.merchantId }, data: { status: 'SUSPENDED' } });

    const response = await probeWithKey(merchant.apiKeyPlaintext);
    expect(response.status).toBe(403);
  });

  it('returns an identical 401 for an unknown key prefix and for a wrong secret on a real prefix', async () => {
    const merchant = await seedMerchant(db);
    const unrelated = await generateApiKey('test');

    const unknownPrefix = await probeWithKey(unrelated.plaintext);
    const [realPrefix] = merchant.apiKeyPlaintext.split('.');
    const wrongSecret = await probeWithKey(`${realPrefix}.${'x'.repeat(32)}`);

    expect(unknownPrefix.status).toBe(401);
    expect(wrongSecret.status).toBe(401);
    expect(unknownPrefix.body.error.code).toBe(wrongSecret.body.error.code);
    expect(unknownPrefix.body.error.message).toBe(wrongSecret.body.error.message);
  });

  it('rejects a key with no Authorization header and a malformed scheme identically to an invalid key', async () => {
    const missing = await server().get('/v1/payment-invoices/nonexistent-id').send();
    const malformedScheme = await server()
      .get('/v1/payment-invoices/nonexistent-id')
      .set('Authorization', 'Basic dXNlcjpwYXNz')
      .send();

    expect(missing.status).toBe(401);
    expect(malformedScheme.status).toBe(401);
  });

  it('never leaks the secret hash in any API response', async () => {
    const merchant = await seedMerchant(db);

    const row = await db.apiKey.findFirstOrThrow({ where: { merchantId: merchant.merchantId } });
    expect(row.secretHash).toBeTruthy();

    // The plaintext-returning create response and the list response are
    // covered by merchant-api-keys.e2e.test.ts; this asserts the raw guard
    // path (a 404 body from an authenticated-but-nonexistent-resource probe)
    // carries nothing key-shaped in it either.
    const response = await probeWithKey(merchant.apiKeyPlaintext);
    const serialized = JSON.stringify(response.body);
    expect(serialized).not.toContain(row.secretHash);
  });
});
