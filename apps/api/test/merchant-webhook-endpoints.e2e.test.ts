import { newId } from '@gateway/shared';
import type { DatabaseClient } from '@gateway/database';
import { createPrismaClient } from '@gateway/database';
import { hashPassword } from '@gateway/security';
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

async function loggedInAgent(merchant: SeededMerchantLogin) {
  const client = request.agent(testApp.app.getHttpServer());
  const login = await client.post('/v1/auth/login').send({ email: merchant.email, password: merchant.password });
  expect(login.status).toBe(200);
  return client;
}

describe('POST /v1/merchant/me/webhook-endpoints', () => {
  it('creates an endpoint, returns the secret once, and never returns it again on GET', async () => {
    const merchant = await seedMerchantWithLogin(db);
    const client = await loggedInAgent(merchant);

    const created = await client
      .post('/v1/merchant/me/webhook-endpoints')
      .set('X-Merchant-Id', merchant.merchantId)
      .send({ url: 'https://merchant.example.com/webhooks', event_types: ['payment.paid'] });

    expect(created.status).toBe(201);
    expect(created.body.secret).toMatch(/^whsec_/);

    const list = await client.get('/v1/merchant/me/webhook-endpoints').set('X-Merchant-Id', merchant.merchantId);
    expect(list.status).toBe(200);
    const row = list.body.find((e: { id: string }) => e.id === created.body.id);
    expect(row.secret).toBeUndefined();
    expect(row.secret_fingerprint).toBeDefined();
  });

  it('disables an endpoint via PATCH', async () => {
    const merchant = await seedMerchantWithLogin(db);
    const client = await loggedInAgent(merchant);

    const created = await client
      .post('/v1/merchant/me/webhook-endpoints')
      .set('X-Merchant-Id', merchant.merchantId)
      .send({ url: 'https://merchant.example.com/webhooks' });

    const patched = await client
      .patch(`/v1/merchant/me/webhook-endpoints/${created.body.id}`)
      .set('X-Merchant-Id', merchant.merchantId)
      .send({ enabled: false });

    expect(patched.status).toBe(200);
    expect(patched.body.enabled).toBe(false);
    expect(patched.body.disabled_reason).toBeTruthy();
  });

  it('rotates the secret, invalidating the fingerprint', async () => {
    const merchant = await seedMerchantWithLogin(db);
    const client = await loggedInAgent(merchant);

    const created = await client
      .post('/v1/merchant/me/webhook-endpoints')
      .set('X-Merchant-Id', merchant.merchantId)
      .send({ url: 'https://merchant.example.com/webhooks' });

    const rotated = await client
      .post(`/v1/merchant/me/webhook-endpoints/${created.body.id}/rotate-secret`)
      .set('X-Merchant-Id', merchant.merchantId)
      .send();

    expect(rotated.status).toBe(201);
    expect(rotated.body.secret).toMatch(/^whsec_/);
    expect(rotated.body.secret).not.toBe(created.body.secret);
    expect(rotated.body.secret_fingerprint).not.toBe(created.body.secret_fingerprint);
  });

  it('a VIEWER member can list but not create', async () => {
    const merchant = await seedMerchantWithLogin(db);

    const viewerId = newId('user');
    // Lowercase: AuthService.login() normalises the presented email to lower
    // case before lookup, and a ULID's characters are uppercase by default.
    const email = `viewer-${viewerId}@example.test`.toLowerCase();
    const password = 'ViewerPassword1!';
    await db.user.create({
      data: { id: viewerId, email, passwordHash: await hashPassword(password), platformRole: 'USER', status: 'ACTIVE' },
    });
    await db.merchantMember.create({ data: { id: newId('user'), merchantId: merchant.merchantId, userId: viewerId, role: 'VIEWER' } });

    const client = request.agent(testApp.app.getHttpServer());
    const login = await client.post('/v1/auth/login').send({ email, password });
    expect(login.status).toBe(200);

    const list = await client.get('/v1/merchant/me/webhook-endpoints').set('X-Merchant-Id', merchant.merchantId);
    expect(list.status).toBe(200);

    const create = await client
      .post('/v1/merchant/me/webhook-endpoints')
      .set('X-Merchant-Id', merchant.merchantId)
      .send({ url: 'https://merchant.example.com/webhooks' });
    expect(create.status).toBe(403);
  });
});
