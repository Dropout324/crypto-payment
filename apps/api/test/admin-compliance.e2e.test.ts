import { newId } from '@gateway/shared';
import type { DatabaseClient } from '@gateway/database';
import { createPrismaClient } from '@gateway/database';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from './support/create-test-app.js';
import { seedAdminUser } from './support/seed-admin-user.js';

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

async function createPendingCheck(): Promise<string> {
  // No dedicated ID_PREFIXES entry exists for compliance checks; a plain
  // unique string is fine here since the id is opaque to this fixture.
  const id = `cc_test_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  await db.complianceCheck.create({
    data: {
      id,
      subjectType: 'invoice',
      subjectId: newId('invoice'),
      checkType: 'sanctions',
      provider: 'test-provider',
      status: 'PENDING',
    },
  });
  return id;
}

describe('POST /v1/admin/compliance-checks/:id/review', () => {
  it('approves a check, moving it to PASSED and recording the reviewer', async () => {
    const admin = await seedAdminUser(db, 'COMPLIANCE_OFFICER');
    const checkId = await createPendingCheck();
    const client = request.agent(testApp.app.getHttpServer());
    await client.post('/v1/auth/login').send({ email: admin.email, password: admin.password });

    const response = await client.post(`/v1/admin/compliance-checks/${checkId}/review`).send({ decision: 'APPROVE', note: 'clean' });

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('PASSED');
    expect(response.body.reviewed_by).toBe(admin.userId);
    expect(response.body.notes).toBe('clean');
  });

  it('rejects a check, moving it to FLAGGED', async () => {
    const admin = await seedAdminUser(db, 'COMPLIANCE_OFFICER');
    const checkId = await createPendingCheck();
    const client = request.agent(testApp.app.getHttpServer());
    await client.post('/v1/auth/login').send({ email: admin.email, password: admin.password });

    const response = await client.post(`/v1/admin/compliance-checks/${checkId}/review`).send({ decision: 'REJECT' });
    expect(response.status).toBe(200);
    expect(response.body.status).toBe('FLAGGED');
  });

  it('refuses to review an already-decided check twice', async () => {
    const admin = await seedAdminUser(db, 'COMPLIANCE_OFFICER');
    const checkId = await createPendingCheck();
    const client = request.agent(testApp.app.getHttpServer());
    await client.post('/v1/auth/login').send({ email: admin.email, password: admin.password });

    await client.post(`/v1/admin/compliance-checks/${checkId}/review`).send({ decision: 'APPROVE' });
    const second = await client.post(`/v1/admin/compliance-checks/${checkId}/review`).send({ decision: 'APPROVE' });
    expect(second.status).toBe(409);
  });

  it('a SUPPORT-role user can list but not review', async () => {
    const support = await seedAdminUser(db, 'SUPPORT');
    const checkId = await createPendingCheck();
    const client = request.agent(testApp.app.getHttpServer());
    await client.post('/v1/auth/login').send({ email: support.email, password: support.password });

    const list = await client.get('/v1/admin/compliance-checks');
    expect(list.status).toBe(200);

    const review = await client.post(`/v1/admin/compliance-checks/${checkId}/review`).send({ decision: 'APPROVE' });
    expect(review.status).toBe(403);
  });
});
