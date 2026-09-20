import type { DatabaseClient } from '@gateway/database';
import { createPrismaClient } from '@gateway/database';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from './support/create-test-app.js';
import { seedMerchantWithLogin, type SeededMerchantLogin } from './support/seed-merchant-login.js';
import { seedCreditedTransfer } from './support/seed-transfer.js';

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

async function loggedInAgent(merchant: SeededMerchantLogin) {
  const client = request.agent(testApp.app.getHttpServer());
  const login = await client.post('/v1/auth/login').send({ email: merchant.email, password: merchant.password });
  expect(login.status).toBe(200);
  return client;
}

describe('GET /v1/merchant/me/invoices', () => {
  it('lists only the calling merchant\'s invoices, scoped by session not API key', async () => {
    const merchant = await seedMerchantWithLogin(db);
    await seedCreditedTransfer(db, { merchantId: merchant.merchantId });
    const client = await loggedInAgent(merchant);

    const response = await client.get('/v1/merchant/me/invoices').set('X-Merchant-Id', merchant.merchantId);

    expect(response.status).toBe(200);
    expect(response.body.invoices).toHaveLength(1);
  });
});

describe('GET /v1/merchant/me/balance', () => {
  it('returns the same shape as the API-key-guarded endpoint', async () => {
    const merchant = await seedMerchantWithLogin(db);
    const client = await loggedInAgent(merchant);

    const response = await client.get('/v1/merchant/me/balance').set('X-Merchant-Id', merchant.merchantId);
    expect(response.status).toBe(200);
    expect(response.body.balances).toEqual([]);
  });
});

describe('GET /v1/merchant/me/transactions', () => {
  it('lists only the calling merchant\'s transfers', async () => {
    const merchant = await seedMerchantWithLogin(db);
    await seedCreditedTransfer(db, { merchantId: merchant.merchantId });
    const client = await loggedInAgent(merchant);

    const response = await client.get('/v1/merchant/me/transactions').set('X-Merchant-Id', merchant.merchantId);
    expect(response.status).toBe(200);
    expect(response.body.transactions).toHaveLength(1);
  });
});

describe('GET /v1/merchant/me/settings', () => {
  it("returns the merchant's payment policy", async () => {
    const merchant = await seedMerchantWithLogin(db, { underpaymentPolicy: 'ACCEPT_PARTIAL' });
    const client = await loggedInAgent(merchant);

    const response = await client.get('/v1/merchant/me/settings').set('X-Merchant-Id', merchant.merchantId);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ id: merchant.merchantId, underpayment_policy: 'ACCEPT_PARTIAL' });
  });

  it('rejects a merchant id header for a merchant the user is not a member of', async () => {
    const merchant = await seedMerchantWithLogin(db);
    const other = await seedMerchantWithLogin(db);
    const client = await loggedInAgent(merchant);

    const response = await client.get('/v1/merchant/me/settings').set('X-Merchant-Id', other.merchantId);
    expect(response.status).toBe(403);
  });

  it('requires the X-Merchant-Id header', async () => {
    const merchant = await seedMerchantWithLogin(db);
    const client = await loggedInAgent(merchant);

    const response = await client.get('/v1/merchant/me/settings');
    expect(response.status).toBe(400);
  });
});
