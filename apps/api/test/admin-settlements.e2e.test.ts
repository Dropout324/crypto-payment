import { newId } from '@gateway/shared';
import type { DatabaseClient } from '@gateway/database';
import { createPrismaClient } from '@gateway/database';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from './support/create-test-app.js';
import { seedAdminUser } from './support/seed-admin-user.js';
import { seedMerchant } from './support/seed-merchant.js';

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

describe('GET /v1/admin/settlements', () => {
  it('lists settlements, filterable by merchant', async () => {
    const admin = await seedAdminUser(db);
    const merchant = await seedMerchant(db);

    await db.settlement.create({
      data: {
        id: newId('settlement'),
        merchantId: merchant.merchantId,
        network: 'ETHEREUM',
        assetSymbol: 'USDT',
        assetDecimals: 6,
        grossAmount: '100000000',
        feeAmount: '1000000',
        networkFee: '0',
        netAmount: '99000000',
        status: 'SCHEDULED',
      },
    });

    const client = request.agent(testApp.app.getHttpServer());
    await client.post('/v1/auth/login').send({ email: admin.email, password: admin.password });

    const response = await client.get('/v1/admin/settlements').query({ merchant_id: merchant.merchantId });
    expect(response.status).toBe(200);
    expect(response.body.settlements).toHaveLength(1);
    expect(response.body.settlements[0]).toMatchObject({ asset: 'USDT', net_amount: '99.000000', status: 'SCHEDULED' });
  });
});
