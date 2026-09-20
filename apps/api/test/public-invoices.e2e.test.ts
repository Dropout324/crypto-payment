import { randomUUID } from 'node:crypto';
import type { DatabaseClient } from '@gateway/database';
import { createPrismaClient } from '@gateway/database';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from './support/create-test-app.js';
import { seedDepositAddress, seedMerchant } from './support/seed-merchant.js';

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

async function newInvoice() {
  const merchant = await seedMerchant(db);
  await seedDepositAddress(db, {
    merchantId: merchant.merchantId,
    network: 'ETHEREUM',
    asset: 'USDT',
    address: `0x${randomUUID().replace(/-/g, '')}`.slice(0, 42),
  });

  const created = await server()
    .post('/v1/payment-invoices')
    .set('Authorization', `Bearer ${merchant.apiKeyPlaintext}`)
    .set('Idempotency-Key', randomUUID())
    .send({ order_id: `ORDER-${randomUUID()}`, amount: '10.00', currency: 'USD', asset: 'USDT', network: 'ethereum' });

  return { merchant, invoiceId: created.body.id as string };
}

describe('GET /v1/public/invoices/:id', () => {
  it('requires no authentication at all', async () => {
    const { invoiceId } = await newInvoice();
    const response = await server().get(`/v1/public/invoices/${invoiceId}`);
    expect(response.status).toBe(200);
  });

  it('returns the merchant name and payment details, but not merchant-internal fields', async () => {
    const { invoiceId } = await newInvoice();
    const response = await server().get(`/v1/public/invoices/${invoiceId}`);

    expect(response.body).toMatchObject({
      id: invoiceId,
      status: 'PENDING',
      amount: '10.00',
      asset: 'USDT',
      network: 'ETHEREUM',
    });
    expect(typeof response.body.merchant_name).toBe('string');
    expect(response.body.payment_address).toMatch(/^0x/);
    expect(response.body).not.toHaveProperty('callback_url');
    expect(response.body).not.toHaveProperty('metadata');
    expect(response.body).not.toHaveProperty('external_reference');
  });

  it('404s for an unknown invoice id', async () => {
    const response = await server().get('/v1/public/invoices/inv_doesnotexist');
    expect(response.status).toBe(404);
  });

  it('lazily expires a PENDING invoice past its deadline, same as the merchant-authenticated read path', async () => {
    const { invoiceId } = await newInvoice();
    const before = await db.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
    await db.invoice.update({
      where: { id: invoiceId },
      data: { expiresAt: new Date(before.createdAt.getTime() + 1) },
    });

    const response = await server().get(`/v1/public/invoices/${invoiceId}`);
    expect(response.body.status).toBe('EXPIRED');
  });
});
