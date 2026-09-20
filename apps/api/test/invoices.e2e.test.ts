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

async function newMerchantWithAddress(network = 'ETHEREUM', asset = 'USDT') {
  const merchant = await seedMerchant(db);
  await seedDepositAddress(db, {
    merchantId: merchant.merchantId,
    network,
    asset,
    address: `0x${randomUUID().replace(/-/g, '')}`.slice(0, 42),
  });
  return merchant;
}

describe('POST /v1/payment-invoices', () => {
  it('creates an invoice and assigns a deposit address', async () => {
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
      });

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      status: 'PENDING',
      amount: '100.00', // USD, 2 decimals
      asset: 'USDT',
      network: 'ETHEREUM',
      crypto_amount: '100.000000', // USDT, 6 decimals, priced 1:1 by the fixed test rate
    });
    expect(response.body.payment_address).toMatch(/^0x/);
    expect(response.body.id).toMatch(/^inv_/);
    expect(new Date(response.body.expires_at).getTime()).toBeGreaterThan(Date.now());
  });

  it('prices a non-1:1 asset using the configured rate, rounding up', async () => {
    const merchant = await newMerchantWithAddress('ETHEREUM', 'ETH');
    await db.paymentAddress.updateMany({ where: { merchantId: merchant.merchantId }, data: { assetSymbol: 'ETH' } });

    const response = await server()
      .post('/v1/payment-invoices')
      .set('Authorization', `Bearer ${merchant.apiKeyPlaintext}`)
      .set('Idempotency-Key', randomUUID())
      .send({ order_id: `ORDER-${randomUUID()}`, amount: '150.00', currency: 'USD', asset: 'ETH', network: 'ethereum' });

    expect(response.status).toBe(201);
    // Fixed test rate: 1 ETH = 3000 USD -> 150 / 3000 = 0.05 ETH exactly.
    expect(response.body.crypto_amount).toBe('0.050000000000000000');
  });

  it('rejects a request with no Idempotency-Key header', async () => {
    const merchant = await newMerchantWithAddress();
    const response = await server()
      .post('/v1/payment-invoices')
      .set('Authorization', `Bearer ${merchant.apiKeyPlaintext}`)
      .send({ order_id: `ORDER-${randomUUID()}`, amount: '10', currency: 'USD', asset: 'USDT', network: 'ethereum' });

    expect(response.status).toBe(400);
    expect(response.body.error.message).toMatch(/Idempotency-Key/);
  });

  it('replays the stored response for a repeated idempotency key with the same body', async () => {
    const merchant = await newMerchantWithAddress();
    const key = randomUUID();
    const body = { order_id: `ORDER-${randomUUID()}`, amount: '25.00', currency: 'USD', asset: 'USDT', network: 'ethereum' };

    const first = await server()
      .post('/v1/payment-invoices')
      .set('Authorization', `Bearer ${merchant.apiKeyPlaintext}`)
      .set('Idempotency-Key', key)
      .send(body);
    const second = await server()
      .post('/v1/payment-invoices')
      .set('Authorization', `Bearer ${merchant.apiKeyPlaintext}`)
      .set('Idempotency-Key', key)
      .send(body);

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body.id).toBe(first.body.id);

    const count = await db.invoice.count({ where: { merchantId: merchant.merchantId } });
    expect(count).toBe(1);
  });

  it('rejects a repeated idempotency key with a different body', async () => {
    const merchant = await newMerchantWithAddress();
    const key = randomUUID();

    const first = await server()
      .post('/v1/payment-invoices')
      .set('Authorization', `Bearer ${merchant.apiKeyPlaintext}`)
      .set('Idempotency-Key', key)
      .send({ order_id: `ORDER-${randomUUID()}`, amount: '25.00', currency: 'USD', asset: 'USDT', network: 'ethereum' });
    expect(first.status).toBe(201);

    const second = await server()
      .post('/v1/payment-invoices')
      .set('Authorization', `Bearer ${merchant.apiKeyPlaintext}`)
      .set('Idempotency-Key', key)
      .send({ order_id: `ORDER-${randomUUID()}`, amount: '99.00', currency: 'USD', asset: 'USDT', network: 'ethereum' });

    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('idempotency_key_reused');
  });

  it('rejects a duplicate order_id for the same merchant', async () => {
    const merchant = await newMerchantWithAddress();
    const orderId = `ORDER-${randomUUID()}`;
    const makeRequest = () =>
      server()
        .post('/v1/payment-invoices')
        .set('Authorization', `Bearer ${merchant.apiKeyPlaintext}`)
        .set('Idempotency-Key', randomUUID())
        .send({ order_id: orderId, amount: '10.00', currency: 'USD', asset: 'USDT', network: 'ethereum' });

    const first = await makeRequest();
    expect(first.status).toBe(201);
    const second = await makeRequest();
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('duplicate_order_id');
  });

  it('rejects an unsupported network', async () => {
    const merchant = await seedMerchant(db);
    const response = await server()
      .post('/v1/payment-invoices')
      .set('Authorization', `Bearer ${merchant.apiKeyPlaintext}`)
      .set('Idempotency-Key', randomUUID())
      .send({ order_id: `ORDER-${randomUUID()}`, amount: '10', currency: 'USD', asset: 'USDT', network: 'dogecoin' });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('unsupported_network');
  });

  it('rejects an asset not allowlisted on the given network', async () => {
    const merchant = await seedMerchant(db);
    const response = await server()
      .post('/v1/payment-invoices')
      .set('Authorization', `Bearer ${merchant.apiKeyPlaintext}`)
      .set('Idempotency-Key', randomUUID())
      .send({ order_id: `ORDER-${randomUUID()}`, amount: '10', currency: 'USD', asset: 'USDT', network: 'bitcoin' });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('unsupported_asset');
  });

  it('rejects a zero or negative amount', async () => {
    const merchant = await newMerchantWithAddress();
    const response = await server()
      .post('/v1/payment-invoices')
      .set('Authorization', `Bearer ${merchant.apiKeyPlaintext}`)
      .set('Idempotency-Key', randomUUID())
      .send({ order_id: `ORDER-${randomUUID()}`, amount: '0', currency: 'USD', asset: 'USDT', network: 'ethereum' });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('invalid_amount');
  });

  it('returns ADDRESS_POOL_EXHAUSTED when the merchant has no available deposit address', async () => {
    const merchant = await seedMerchant(db); // no address registered
    const response = await server()
      .post('/v1/payment-invoices')
      .set('Authorization', `Bearer ${merchant.apiKeyPlaintext}`)
      .set('Idempotency-Key', randomUUID())
      .send({ order_id: `ORDER-${randomUUID()}`, amount: '10.00', currency: 'USD', asset: 'USDT', network: 'ethereum' });

    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe('address_pool_exhausted');
  });

  it('never assigns one address to two invoices', async () => {
    const merchant = await newMerchantWithAddress();

    const [a, b] = await Promise.all([
      server()
        .post('/v1/payment-invoices')
        .set('Authorization', `Bearer ${merchant.apiKeyPlaintext}`)
        .set('Idempotency-Key', randomUUID())
        .send({ order_id: `ORDER-A-${randomUUID()}`, amount: '10.00', currency: 'USD', asset: 'USDT', network: 'ethereum' }),
      server()
        .post('/v1/payment-invoices')
        .set('Authorization', `Bearer ${merchant.apiKeyPlaintext}`)
        .set('Idempotency-Key', randomUUID())
        .send({ order_id: `ORDER-B-${randomUUID()}`, amount: '10.00', currency: 'USD', asset: 'USDT', network: 'ethereum' }),
    ]);

    // Exactly one had an address available; the other must fail cleanly, never
    // both succeed with the same address.
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([201, 422]);
  });
});

describe('auth', () => {
  it('rejects a request with no Authorization header', async () => {
    const response = await server().get('/v1/payment-invoices/inv_doesnotexist');
    expect(response.status).toBe(401);
  });

  it('rejects a malformed bearer token', async () => {
    const response = await server()
      .get('/v1/payment-invoices/inv_doesnotexist')
      .set('Authorization', 'Bearer garbage');
    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('invalid_credentials');
  });

  it('rejects a well-formed but wrong secret', async () => {
    const merchant = await seedMerchant(db);
    const [prefix] = merchant.apiKeyPlaintext.split('.');
    const response = await server()
      .get('/v1/payment-invoices/inv_doesnotexist')
      .set('Authorization', `Bearer ${prefix}.${'a'.repeat(40)}`);
    expect(response.status).toBe(401);
  });

  it('never returns another merchant\'s invoice', async () => {
    const owner = await newMerchantWithAddress();
    const intruder = await seedMerchant(db);

    const created = await server()
      .post('/v1/payment-invoices')
      .set('Authorization', `Bearer ${owner.apiKeyPlaintext}`)
      .set('Idempotency-Key', randomUUID())
      .send({ order_id: `ORDER-${randomUUID()}`, amount: '10.00', currency: 'USD', asset: 'USDT', network: 'ethereum' });

    const response = await server()
      .get(`/v1/payment-invoices/${created.body.id}`)
      .set('Authorization', `Bearer ${intruder.apiKeyPlaintext}`);

    expect(response.status).toBe(404);
  });
});

describe('GET /v1/payment-invoices/:id and /status', () => {
  it('returns the created invoice', async () => {
    const merchant = await newMerchantWithAddress();
    const created = await server()
      .post('/v1/payment-invoices')
      .set('Authorization', `Bearer ${merchant.apiKeyPlaintext}`)
      .set('Idempotency-Key', randomUUID())
      .send({ order_id: `ORDER-${randomUUID()}`, amount: '10.00', currency: 'USD', asset: 'USDT', network: 'ethereum' });

    const response = await server()
      .get(`/v1/payment-invoices/${created.body.id}`)
      .set('Authorization', `Bearer ${merchant.apiKeyPlaintext}`);

    expect(response.status).toBe(200);
    expect(response.body.id).toBe(created.body.id);
  });

  it('404s for an unknown invoice id', async () => {
    const merchant = await seedMerchant(db);
    const response = await server()
      .get('/v1/payment-invoices/inv_doesnotexist')
      .set('Authorization', `Bearer ${merchant.apiKeyPlaintext}`);
    expect(response.status).toBe(404);
  });

  it('returns a minimal status payload', async () => {
    const merchant = await newMerchantWithAddress();
    const created = await server()
      .post('/v1/payment-invoices')
      .set('Authorization', `Bearer ${merchant.apiKeyPlaintext}`)
      .set('Idempotency-Key', randomUUID())
      .send({ order_id: `ORDER-${randomUUID()}`, amount: '10.00', currency: 'USD', asset: 'USDT', network: 'ethereum' });

    const response = await server()
      .get(`/v1/payment-invoices/${created.body.id}/status`)
      .set('Authorization', `Bearer ${merchant.apiKeyPlaintext}`);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ id: created.body.id, status: 'PENDING', confirmation_count: 0 });
  });

  it('lazily expires a PENDING invoice once its deadline has passed', async () => {
    const merchant = await newMerchantWithAddress();
    const created = await server()
      .post('/v1/payment-invoices')
      .set('Authorization', `Bearer ${merchant.apiKeyPlaintext}`)
      .set('Idempotency-Key', randomUUID())
      .send({ order_id: `ORDER-${randomUUID()}`, amount: '10.00', currency: 'USD', asset: 'USDT', network: 'ethereum' });

    // Force the deadline into the past, bypassing the API (SPEC: the API never
    // lets a caller set this directly). expiresAt must stay strictly after
    // createdAt (a DB CHECK constraint enforces it, and createdAt itself is
    // immutable), so back-date it to just 1ms after the invoice's real
    // creation time - already in the past by the time this test reads it.
    const beforeExpire = await db.invoice.findUniqueOrThrow({ where: { id: created.body.id } });
    await db.invoice.update({
      where: { id: created.body.id },
      data: { expiresAt: new Date(beforeExpire.createdAt.getTime() + 1) },
    });

    const response = await server()
      .get(`/v1/payment-invoices/${created.body.id}/status`)
      .set('Authorization', `Bearer ${merchant.apiKeyPlaintext}`);

    expect(response.body.status).toBe('EXPIRED');

    const events = await db.paymentEvent.findMany({ where: { invoiceId: created.body.id }, orderBy: { sequence: 'asc' } });
    expect(events.at(-1)).toMatchObject({ type: 'payment.expired', toStatus: 'EXPIRED' });
  });
});

describe('POST /v1/payment-invoices/:id/cancel', () => {
  it('cancels a pending invoice and retires its address', async () => {
    const merchant = await newMerchantWithAddress();
    const created = await server()
      .post('/v1/payment-invoices')
      .set('Authorization', `Bearer ${merchant.apiKeyPlaintext}`)
      .set('Idempotency-Key', randomUUID())
      .send({ order_id: `ORDER-${randomUUID()}`, amount: '10.00', currency: 'USD', asset: 'USDT', network: 'ethereum' });

    const response = await server()
      .post(`/v1/payment-invoices/${created.body.id}/cancel`)
      .set('Authorization', `Bearer ${merchant.apiKeyPlaintext}`)
      .send({});

    expect(response.status).toBe(201);
    expect(response.body.status).toBe('CANCELLED');

    const address = await db.paymentAddress.findFirst({ where: { invoiceId: created.body.id } });
    expect(address?.status).toBe('RETIRED');
  });

  it('refuses to cancel an already-cancelled invoice', async () => {
    const merchant = await newMerchantWithAddress();
    const created = await server()
      .post('/v1/payment-invoices')
      .set('Authorization', `Bearer ${merchant.apiKeyPlaintext}`)
      .set('Idempotency-Key', randomUUID())
      .send({ order_id: `ORDER-${randomUUID()}`, amount: '10.00', currency: 'USD', asset: 'USDT', network: 'ethereum' });

    await server()
      .post(`/v1/payment-invoices/${created.body.id}/cancel`)
      .set('Authorization', `Bearer ${merchant.apiKeyPlaintext}`)
      .send({});

    const second = await server()
      .post(`/v1/payment-invoices/${created.body.id}/cancel`)
      .set('Authorization', `Bearer ${merchant.apiKeyPlaintext}`)
      .send({});

    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('invalid_state_transition');
  });
});
