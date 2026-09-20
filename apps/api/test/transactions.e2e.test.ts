import type { DatabaseClient } from '@gateway/database';
import { createPrismaClient } from '@gateway/database';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from './support/create-test-app.js';
import { seedMerchant } from './support/seed-merchant.js';
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

function server() {
  return request(testApp.app.getHttpServer());
}

describe('GET /v1/transactions/:hash', () => {
  it("returns the transaction and its transfers for the owning merchant", async () => {
    const merchant = await seedMerchant(db);
    const transfer = await seedCreditedTransfer(db, { merchantId: merchant.merchantId });

    const response = await server()
      .get(`/v1/transactions/${transfer.txHash}`)
      .query({ network: 'ethereum' })
      .set('Authorization', `Bearer ${merchant.apiKeyPlaintext}`);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ network: 'ETHEREUM', tx_hash: transfer.txHash, status: 'CONFIRMED' });
    expect(response.body.transfers).toHaveLength(1);
    expect(response.body.transfers[0]).toMatchObject({ asset: 'USDT', amount: '100.000000', match_status: 'CREDITED' });
  });

  it("404s for another merchant's transaction", async () => {
    const owner = await seedMerchant(db);
    const stranger = await seedMerchant(db);
    const transfer = await seedCreditedTransfer(db, { merchantId: owner.merchantId });

    const response = await server()
      .get(`/v1/transactions/${transfer.txHash}`)
      .query({ network: 'ethereum' })
      .set('Authorization', `Bearer ${stranger.apiKeyPlaintext}`);

    expect(response.status).toBe(404);
  });

  it('requires the network query parameter', async () => {
    const merchant = await seedMerchant(db);
    const response = await server()
      .get('/v1/transactions/0xdeadbeef')
      .set('Authorization', `Bearer ${merchant.apiKeyPlaintext}`);

    expect(response.status).toBe(400);
  });

  it('404s when the hash exists on a different network', async () => {
    const merchant = await seedMerchant(db);
    const transfer = await seedCreditedTransfer(db, { merchantId: merchant.merchantId, network: 'ETHEREUM' });

    const response = await server()
      .get(`/v1/transactions/${transfer.txHash}`)
      .query({ network: 'polygon' })
      .set('Authorization', `Bearer ${merchant.apiKeyPlaintext}`);

    expect(response.status).toBe(404);
  });

  it('rejects an unauthenticated request', async () => {
    const response = await server().get('/v1/transactions/0xdeadbeef').query({ network: 'ethereum' });
    expect(response.status).toBe(401);
  });
});
