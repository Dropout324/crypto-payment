import type { DatabaseClient } from '@gateway/database';
import { createPrismaClient } from '@gateway/database';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from './support/create-test-app.js';
import { seedMerchantWithLogin, type SeededMerchantLogin } from './support/seed-merchant-login.js';

let testApp: TestApp;
let db: DatabaseClient;

beforeAll(async () => {
  testApp = await createTestApp();
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

async function loggedInAgent(merchant: SeededMerchantLogin) {
  const client = request.agent(testApp.app.getHttpServer());
  const login = await client.post('/v1/auth/login').send({ email: merchant.email, password: merchant.password });
  expect(login.status).toBe(200);
  return client;
}

describe('POST /v1/merchant/me/api-keys', () => {
  it('creates a key, returns the plaintext once, and never returns it again on GET', async () => {
    const merchant = await seedMerchantWithLogin(db);
    const client = await loggedInAgent(merchant);

    const created = await client
      .post('/v1/merchant/me/api-keys')
      .set('X-Merchant-Id', merchant.merchantId)
      .send({ name: 'CI key', livemode: false });

    expect(created.status).toBe(201);
    expect(created.body.plaintext).toMatch(/^pk_test_/);
    expect(created.body.key_prefix).toBe(created.body.plaintext.split('.')[0]);

    const list = await client.get('/v1/merchant/me/api-keys').set('X-Merchant-Id', merchant.merchantId);
    expect(list.status).toBe(200);
    const row = list.body.find((k: { id: string }) => k.id === created.body.id);
    expect(row).toBeDefined();
    expect(row.plaintext).toBeUndefined();
  });

  it('revokes a key so it can no longer authenticate', async () => {
    const merchant = await seedMerchantWithLogin(db);
    const client = await loggedInAgent(merchant);

    const created = await client
      .post('/v1/merchant/me/api-keys')
      .set('X-Merchant-Id', merchant.merchantId)
      .send({ name: 'to revoke' });

    const revoked = await client.post(`/v1/merchant/me/api-keys/${created.body.id}/revoke`).set('X-Merchant-Id', merchant.merchantId);
    expect(revoked.status).toBe(201); // Nest's default for POST with no explicit @HttpCode, matching invoices' cancel action
    expect(revoked.body.status).toBe('REVOKED');

    const probe = await server().get('/v1/merchant/balance').set('Authorization', `Bearer ${created.body.plaintext}`);
    expect(probe.status).toBe(401);
  });

  it('rejects a request without a session', async () => {
    const response = await server().get('/v1/merchant/me/api-keys').set('X-Merchant-Id', 'mch_x');
    expect(response.status).toBe(401);
  });

  it('rejects a request for a merchant the user does not belong to', async () => {
    const merchant = await seedMerchantWithLogin(db);
    const other = await seedMerchantWithLogin(db);
    const client = await loggedInAgent(merchant);

    const response = await client.get('/v1/merchant/me/api-keys').set('X-Merchant-Id', other.merchantId);
    expect(response.status).toBe(403);
  });
});
