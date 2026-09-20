import type { DatabaseClient } from '@gateway/database';
import { createPrismaClient } from '@gateway/database';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from './support/create-test-app.js';
import { seedAdminUser } from './support/seed-admin-user.js';
import { seedMerchant } from './support/seed-merchant.js';
import { seedUser, type SeededUser } from './support/seed-user.js';

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

async function loggedInAgent(admin: SeededUser) {
  const client = request.agent(testApp.app.getHttpServer());
  const login = await client.post('/v1/auth/login').send({ email: admin.email, password: admin.password });
  expect(login.status).toBe(200);
  return client;
}

describe('GET /v1/admin/merchants', () => {
  it('lists and fetches a merchant', async () => {
    const admin = await seedAdminUser(db);
    const merchant = await seedMerchant(db);
    const client = await loggedInAgent(admin);

    // Ascending-by-id, no-cursor pagination over a shared test database can
    // legitimately not include a freshly created row on the first page -
    // older fixtures from earlier test files sort first (see Milestone 2's
    // dedicated pagination-correctness tests for that guarantee). This just
    // proves the list endpoint itself works; the detail fetch below proves
    // this specific merchant is reachable.
    const list = await client.get('/v1/admin/merchants');
    expect(list.status).toBe(200);
    expect(Array.isArray(list.body.merchants)).toBe(true);

    const detail = await client.get(`/v1/admin/merchants/${merchant.merchantId}`);
    expect(detail.status).toBe(200);
    expect(detail.body.status).toBe('ACTIVE');
  });

  it('rejects an unauthenticated request', async () => {
    const response = await server().get('/v1/admin/merchants');
    expect(response.status).toBe(401);
  });
});

describe('POST /v1/admin/merchants/:id/suspend', () => {
  it('suspends and reactivates a merchant, writing an audit log for each', async () => {
    const admin = await seedAdminUser(db);
    const merchant = await seedMerchant(db);
    const client = await loggedInAgent(admin);

    const suspended = await client.post(`/v1/admin/merchants/${merchant.merchantId}/suspend`);
    expect(suspended.status).toBe(200);
    expect(suspended.body.status).toBe('SUSPENDED');

    const auditRow = await db.auditLog.findFirst({
      where: { resourceId: merchant.merchantId, action: 'merchant.suspended' },
    });
    expect(auditRow).toBeTruthy();
    expect(auditRow?.userId).toBe(admin.userId);

    const reactivated = await client.post(`/v1/admin/merchants/${merchant.merchantId}/reactivate`);
    expect(reactivated.status).toBe(200);
    expect(reactivated.body.status).toBe('ACTIVE');
  });

  it('refuses to suspend an already-suspended merchant', async () => {
    const admin = await seedAdminUser(db);
    const merchant = await seedMerchant(db);
    const client = await loggedInAgent(admin);

    await client.post(`/v1/admin/merchants/${merchant.merchantId}/suspend`);
    const second = await client.post(`/v1/admin/merchants/${merchant.merchantId}/suspend`);
    expect(second.status).toBe(409);
  });

  it('rejects a SUPPORT-role user (read-only)', async () => {
    const support = await seedAdminUser(db, 'SUPPORT');
    const merchant = await seedMerchant(db);
    const client = await loggedInAgent(support);

    const list = await client.get('/v1/admin/merchants');
    expect(list.status).toBe(200);

    const suspend = await client.post(`/v1/admin/merchants/${merchant.merchantId}/suspend`);
    expect(suspend.status).toBe(403);
  });

  it('rejects a plain USER platform role entirely', async () => {
    const user = await seedUser(db, { platformRole: 'USER' });
    const client = await loggedInAgent(user);

    const response = await client.get('/v1/admin/merchants');
    expect(response.status).toBe(403);
  });
});
