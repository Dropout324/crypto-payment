import { randomUUID } from 'node:crypto';
import type { DatabaseClient } from '@gateway/database';
import { createPrismaClient } from '@gateway/database';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../support/create-test-app.js';
import { seedDepositAddress, seedMerchant } from '../support/seed-merchant.js';
import { seedMerchantWithLogin } from '../support/seed-merchant-login.js';

/**
 * `ApiKey.scopes` was stored and returned in every response but never
 * enforced (Phase 17 pass 1 known gap - docs/commercial/readiness-roadmap.md).
 * `ApiKeyScopeGuard` (apps/api/src/auth/api-key-scope.guard.js) is what
 * closes it; this proves an under-scoped key is actually rejected, not just
 * that the guard exists.
 */

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

async function newMerchantWithAddress(scopes: string[]) {
  const merchant = await seedMerchant(db, { scopes });
  await seedDepositAddress(db, {
    merchantId: merchant.merchantId,
    network: 'ETHEREUM',
    asset: 'USDT',
    address: `0x${randomUUID().replace(/-/g, '')}`.slice(0, 42),
  });
  return merchant;
}

describe('API key scope enforcement', () => {
  it('rejects invoice creation for a key without invoices:write', async () => {
    const merchant = await newMerchantWithAddress(['invoices:read']);

    const response = await server()
      .post('/v1/payment-invoices')
      .set('Authorization', `Bearer ${merchant.apiKeyPlaintext}`)
      .set('Idempotency-Key', randomUUID())
      .send({ order_id: `ORDER-${randomUUID()}`, amount: '100.00', currency: 'USD', asset: 'USDT', network: 'ethereum' });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('forbidden');
    expect(response.body.error.details.missing_scopes).toEqual(['invoices:write']);
  });

  it('allows invoice creation for a key with invoices:write', async () => {
    const merchant = await newMerchantWithAddress(['invoices:write']);

    const response = await server()
      .post('/v1/payment-invoices')
      .set('Authorization', `Bearer ${merchant.apiKeyPlaintext}`)
      .set('Idempotency-Key', randomUUID())
      .send({ order_id: `ORDER-${randomUUID()}`, amount: '100.00', currency: 'USD', asset: 'USDT', network: 'ethereum' });

    expect(response.status).toBe(201);
  });

  it('rejects reading an invoice for a key without invoices:read', async () => {
    const merchant = await newMerchantWithAddress(['invoices:write']);
    const create = await server()
      .post('/v1/payment-invoices')
      .set('Authorization', `Bearer ${merchant.apiKeyPlaintext}`)
      .set('Idempotency-Key', randomUUID())
      .send({ order_id: `ORDER-${randomUUID()}`, amount: '100.00', currency: 'USD', asset: 'USDT', network: 'ethereum' });
    expect(create.status).toBe(201);

    const response = await server()
      .get(`/v1/payment-invoices/${create.body.id}`)
      .set('Authorization', `Bearer ${merchant.apiKeyPlaintext}`);

    expect(response.status).toBe(403);
  });

  it('rejects registering a deposit address for a key without addresses:write', async () => {
    const merchant = await seedMerchant(db, { scopes: ['addresses:read'] });

    const response = await server()
      .post('/v1/merchant/addresses')
      .set('Authorization', `Bearer ${merchant.apiKeyPlaintext}`)
      .send({ network: 'ethereum', asset: 'USDT', address: `0x${randomUUID().replace(/-/g, '')}`.slice(0, 42) });

    expect(response.status).toBe(403);
  });

  it('rejects reading the balance for a key without balance:read', async () => {
    const merchant = await seedMerchant(db, { scopes: ['invoices:read', 'invoices:write'] });

    const response = await server()
      .get('/v1/merchant/balance')
      .set('Authorization', `Bearer ${merchant.apiKeyPlaintext}`);

    expect(response.status).toBe(403);
  });

  it('a key created via the dashboard API with no scopes field gets every scope (backward-compatible default)', async () => {
    const merchant = await seedMerchantWithLogin(db);
    const client = request.agent(testApp.app.getHttpServer());
    const login = await client.post('/v1/auth/login').send({ email: merchant.email, password: merchant.password });
    expect(login.status).toBe(200);

    const created = await client
      .post('/v1/merchant/me/api-keys')
      .set('X-Merchant-Id', merchant.merchantId)
      .send({ name: 'no scopes specified' });

    expect(created.status).toBe(201);
    expect(created.body.scopes.length).toBeGreaterThan(0);
    expect(created.body.scopes).toContain('invoices:write');
  });

  it('rejects creating an API key with an unrecognised scope string', async () => {
    const merchant = await seedMerchantWithLogin(db);
    const client = request.agent(testApp.app.getHttpServer());
    const login = await client.post('/v1/auth/login').send({ email: merchant.email, password: merchant.password });
    expect(login.status).toBe(200);

    const created = await client
      .post('/v1/merchant/me/api-keys')
      .set('X-Merchant-Id', merchant.merchantId)
      .send({ name: 'bad scope', scopes: ['invoices:delete_everything'] });

    expect(created.status).toBe(400);
  });
});
