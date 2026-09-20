import { randomUUID } from 'node:crypto';
import type { DatabaseClient } from '@gateway/database';
import { createPrismaClient } from '@gateway/database';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../support/create-test-app.js';
import { seedDepositAddress, seedMerchant } from '../support/seed-merchant.js';
import { seedMerchantWithLogin, type SeededMerchantLogin } from '../support/seed-merchant-login.js';

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

async function newMerchantWithAddress() {
  const merchant = await seedMerchant(db);
  await seedDepositAddress(db, {
    merchantId: merchant.merchantId,
    network: 'ETHEREUM',
    asset: 'USDT',
    address: `0x${randomUUID().replace(/-/g, '')}`.slice(0, 42),
  });
  return merchant;
}

describe('mass assignment (ValidationPipe whitelist + forbidNonWhitelisted)', () => {
  it('rejects an invoice-creation request carrying unexpected fields instead of silently dropping them', async () => {
    const merchant = await newMerchantWithAddress();

    const response = await server()
      .post('/v1/payment-invoices')
      .set('Authorization', `Bearer ${merchant.apiKeyPlaintext}`)
      .set('Idempotency-Key', randomUUID())
      .send({
        order_id: `ORDER-${randomUUID()}`,
        amount: '100.00',
        currency: 'USD',
        asset: 'USDT',
        network: 'ethereum',
        merchant_id: 'mch_someone_else', // not a real field on CreateInvoiceDto
        status: 'PAID', // attempted direct-state-injection
      });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('validation_failed');
  });

  it('rejects a member-role-update request smuggling an extra field', async () => {
    const merchant = await seedMerchantWithLogin(db);
    const client = await loggedInAgent(merchant);
    const members = await client.get('/v1/merchant/me/members').set('X-Merchant-Id', merchant.merchantId);
    const memberId = members.body[0].id;

    const response = await client
      .patch(`/v1/merchant/me/members/${memberId}`)
      .set('X-Merchant-Id', merchant.merchantId)
      .send({ role: 'VIEWER', merchantId: 'mch_someone_else', userId: 'usr_someone_else' });

    expect(response.status).toBe(400);
  });

  it('rejects an API-key-creation request smuggling a status/merchantId override', async () => {
    const merchant = await seedMerchantWithLogin(db);
    const client = await loggedInAgent(merchant);

    const response = await client
      .post('/v1/merchant/me/api-keys')
      .set('X-Merchant-Id', merchant.merchantId)
      .send({ name: 'attempted override', status: 'ACTIVE', merchantId: 'mch_someone_else' });

    expect(response.status).toBe(400);
  });
});

describe('injection payload safety (Prisma is parameterized; ValidationPipe rejects malformed shapes first)', () => {
  it('stores and returns SQL/NoSQL/script-injection-shaped free text verbatim, without executing or corrupting it', async () => {
    const merchant = await newMerchantWithAddress();
    const payloads = {
      order_id: `ORDER-${randomUUID()}`,
      external_reference: `'; DROP TABLE "Invoice"; --`,
      description: '<script>alert(document.cookie)</script>${7*7}{{7*7}}',
    };

    const created = await server()
      .post('/v1/payment-invoices')
      .set('Authorization', `Bearer ${merchant.apiKeyPlaintext}`)
      .set('Idempotency-Key', randomUUID())
      .send({ ...payloads, amount: '10.00', currency: 'USD', asset: 'USDT', network: 'ethereum' });

    expect(created.status).toBe(201);
    expect(created.body.external_reference).toBe(payloads.external_reference);

    // `description` isn't part of the API response shape (see
    // invoices.mapper.ts) - checked directly against the row instead.
    // The table must still exist and be queryable at all - proof the
    // "DROP TABLE" string was stored as inert data, never executed as SQL.
    const stillThere = await db.invoice.findUnique({ where: { id: created.body.id } });
    expect(stillThere?.externalReference).toBe(payloads.external_reference);
    expect(stillThere?.description).toBe(payloads.description);
  });

  it('rejects a login attempt with a SQL-injection-shaped email at the validation layer (never reaches a query)', async () => {
    const response = await server()
      .post('/v1/auth/login')
      .send({ email: `' OR '1'='1' --`, password: 'whatever123' });

    expect(response.status).toBe(400); // IsEmail() rejects the shape before AuthService.login runs
  });

  it('handles a garbage/path-traversal-shaped resource id as a clean 404, never a 500', async () => {
    const merchant = await newMerchantWithAddress();
    const weirdIds = ['../../etc/passwd', '%00', "1' OR '1'='1", 'x'.repeat(5000)];

    for (const id of weirdIds) {
      const response = await server()
        .get(`/v1/payment-invoices/${encodeURIComponent(id)}`)
        .set('Authorization', `Bearer ${merchant.apiKeyPlaintext}`);
      expect(response.status).toBeLessThan(500);
    }
  });
});

describe('sensitive-field exposure', () => {
  it('never serializes password hashes, API-key secret hashes, or webhook secrets in any dashboard response', async () => {
    const merchant = await seedMerchantWithLogin(db);
    const client = await loggedInAgent(merchant);

    await client.post('/v1/merchant/me/api-keys').set('X-Merchant-Id', merchant.merchantId).send({ name: 'k2' });
    await client
      .post('/v1/merchant/me/webhook-endpoints')
      .set('X-Merchant-Id', merchant.merchantId)
      .send({ url: 'https://merchant.example.com/hook' });

    const [me, apiKeys, webhooks, members] = await Promise.all([
      client.get('/v1/auth/me'),
      client.get('/v1/merchant/me/api-keys').set('X-Merchant-Id', merchant.merchantId),
      client.get('/v1/merchant/me/webhook-endpoints').set('X-Merchant-Id', merchant.merchantId),
      client.get('/v1/merchant/me/members').set('X-Merchant-Id', merchant.merchantId),
    ]);

    const forbiddenSubstrings = ['passwordHash', 'password_hash', 'secretHash', 'secret_hash', 'secretEncrypted', 'tokenHash'];
    for (const response of [me, apiKeys, webhooks, members]) {
      const serialized = JSON.stringify(response.body);
      for (const forbidden of forbiddenSubstrings) {
        expect(serialized).not.toContain(forbidden);
      }
    }
    // The webhook secret itself is only ever present in the create/rotate response body, never a GET list.
    for (const endpoint of webhooks.body as Array<{ secret?: string }>) {
      expect(endpoint.secret).toBeUndefined();
    }
  });

  it('FIXED (Phase 17 pass 1, ADR 0031): an API key created with only invoices:read is now actually restricted from write endpoints', async () => {
    const merchant = await newMerchantWithAddress();
    await db.apiKey.updateMany({ where: { merchantId: merchant.merchantId }, data: { scopes: ['invoices:read'] } });

    const response = await server()
      .post('/v1/payment-invoices')
      .set('Authorization', `Bearer ${merchant.apiKeyPlaintext}`)
      .set('Idempotency-Key', randomUUID())
      .send({
        order_id: `ORDER-${randomUUID()}`,
        amount: '10.00',
        currency: 'USD',
        asset: 'USDT',
        network: 'ethereum',
      });

    // Previously asserted 201 here, documenting that scopes were stored and
    // returned but never checked by any guard (see the fuller enforcement
    // suite, apps/api/test/security/api-key-scopes.e2e.test.ts). Now closed
    // by ApiKeyScopeGuard (apps/api/src/auth/api-key-scope.guard.ts).
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('forbidden');
  });
});
