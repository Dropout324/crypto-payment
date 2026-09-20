import type { DatabaseClient } from '@gateway/database';
import { createPrismaClient } from '@gateway/database';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from './support/create-test-app.js';
import { seedAdminUser } from './support/seed-admin-user.js';
import { seedMerchant } from './support/seed-merchant.js';
import type { SeededUser } from './support/seed-user.js';

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

async function loggedInAgent(admin: SeededUser) {
  const client = request.agent(testApp.app.getHttpServer());
  const login = await client.post('/v1/auth/login').send({ email: admin.email, password: admin.password });
  expect(login.status).toBe(200);
  return client;
}

describe('GET /v1/admin/audit-logs', () => {
  it('an ADMIN can read the trail an earlier action wrote, including ip and user agent', async () => {
    const admin = await seedAdminUser(db);
    const merchant = await seedMerchant(db);
    const client = await loggedInAgent(admin);

    const suspend = await client
      .post(`/v1/admin/merchants/${merchant.merchantId}/suspend`)
      .set('User-Agent', 'audit-log-test-agent/1.0');
    expect(suspend.status).toBe(200);

    const logs = await client.get('/v1/admin/audit-logs').query({ resource_type: 'merchant', action: 'merchant.suspended' });
    expect(logs.status).toBe(200);
    const entry = logs.body.audit_logs.find((row: { resource_id: string }) => row.resource_id === merchant.merchantId);
    expect(entry).toBeTruthy();
    expect(entry.user_id).toBe(admin.userId);
    expect(entry.user_agent).toBe('audit-log-test-agent/1.0');
    expect(entry.ip_address).toBeTruthy();
  });

  it('rejects a SUPPORT-role user - audit logs are compliance/admin only', async () => {
    const support = await seedAdminUser(db, 'SUPPORT');
    const client = await loggedInAgent(support);

    const response = await client.get('/v1/admin/audit-logs');
    expect(response.status).toBe(403);
  });

  it('a COMPLIANCE_OFFICER can read the trail', async () => {
    const compliance = await seedAdminUser(db, 'COMPLIANCE_OFFICER');
    const client = await loggedInAgent(compliance);

    const response = await client.get('/v1/admin/audit-logs');
    expect(response.status).toBe(200);
  });
});
