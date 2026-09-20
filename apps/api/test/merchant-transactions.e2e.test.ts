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

describe('GET /v1/merchant/transactions', () => {
  it('lists only the calling merchant\'s transfers', async () => {
    const owner = await seedMerchant(db);
    const stranger = await seedMerchant(db);
    await seedCreditedTransfer(db, { merchantId: owner.merchantId });
    await seedCreditedTransfer(db, { merchantId: stranger.merchantId });

    const response = await server()
      .get('/v1/merchant/transactions')
      .set('Authorization', `Bearer ${owner.apiKeyPlaintext}`);

    expect(response.status).toBe(200);
    expect(response.body.transactions).toHaveLength(1);
  });

  it('paginates with a cursor, returning every row exactly once across pages', async () => {
    const merchant = await seedMerchant(db);
    const seeded = [];
    for (let i = 0; i < 5; i += 1) {
      seeded.push(await seedCreditedTransfer(db, { merchantId: merchant.merchantId }));
    }

    const firstPage = await server()
      .get('/v1/merchant/transactions')
      .query({ limit: 2 })
      .set('Authorization', `Bearer ${merchant.apiKeyPlaintext}`);

    expect(firstPage.status).toBe(200);
    expect(firstPage.body.transactions).toHaveLength(2);
    expect(firstPage.body.next_cursor).not.toBeNull();

    const secondPage = await server()
      .get('/v1/merchant/transactions')
      .query({ limit: 2, cursor: firstPage.body.next_cursor })
      .set('Authorization', `Bearer ${merchant.apiKeyPlaintext}`);

    expect(secondPage.status).toBe(200);
    expect(secondPage.body.transactions).toHaveLength(2);

    const thirdPage = await server()
      .get('/v1/merchant/transactions')
      .query({ limit: 2, cursor: secondPage.body.next_cursor })
      .set('Authorization', `Bearer ${merchant.apiKeyPlaintext}`);

    expect(thirdPage.status).toBe(200);
    expect(thirdPage.body.transactions).toHaveLength(1);
    expect(thirdPage.body.next_cursor).toBeNull();

    const allIds = [
      ...firstPage.body.transactions,
      ...secondPage.body.transactions,
      ...thirdPage.body.transactions,
    ].map((t: { id: string }) => t.id);
    expect(new Set(allIds).size).toBe(5); // no duplicates, no gaps
    expect(allIds.sort()).toEqual(seeded.map((s) => s.transferId).sort());
  });

  it('rejects a limit outside [1, 100]', async () => {
    const merchant = await seedMerchant(db);
    const response = await server()
      .get('/v1/merchant/transactions')
      .query({ limit: 0 })
      .set('Authorization', `Bearer ${merchant.apiKeyPlaintext}`);

    expect(response.status).toBe(400);
  });

  it('filters by network', async () => {
    const merchant = await seedMerchant(db);
    await seedCreditedTransfer(db, { merchantId: merchant.merchantId, network: 'ETHEREUM' });
    await seedCreditedTransfer(db, { merchantId: merchant.merchantId, network: 'POLYGON', asset: 'USDT' });

    const response = await server()
      .get('/v1/merchant/transactions')
      .query({ network: 'polygon' })
      .set('Authorization', `Bearer ${merchant.apiKeyPlaintext}`);

    expect(response.status).toBe(200);
    expect(response.body.transactions).toHaveLength(1);
    expect(response.body.transactions[0].network).toBe('POLYGON');
  });
});
