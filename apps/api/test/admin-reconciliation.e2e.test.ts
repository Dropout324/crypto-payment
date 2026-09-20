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

async function createOpenDiscrepancy(): Promise<string> {
  const runId = newId('reconciliation');
  await db.reconciliationRun.create({
    data: {
      id: runId,
      scope: 'ledger_balance',
      status: 'DISCREPANCIES_FOUND',
      periodStart: new Date(Date.now() - 3_600_000),
      periodEnd: new Date(),
    },
  });

  const discrepancyId = `disc_test_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  await db.reconciliationDiscrepancy.create({
    data: {
      id: discrepancyId,
      runId,
      kind: 'LEDGER_IMBALANCE',
      severity: 'CRITICAL',
      subjectType: 'ledger_account',
      subjectId: newId('ledgerAccount'),
      expectedValue: '100',
      actualValue: '95',
    },
  });
  return discrepancyId;
}

describe('POST /v1/admin/reconciliation-discrepancies/:id/resolve', () => {
  it('resolves a discrepancy and records who resolved it', async () => {
    const admin = await seedAdminUser(db);
    const discrepancyId = await createOpenDiscrepancy();
    const client = request.agent(testApp.app.getHttpServer());
    await client.post('/v1/auth/login').send({ email: admin.email, password: admin.password });

    const response = await client
      .post(`/v1/admin/reconciliation-discrepancies/${discrepancyId}/resolve`)
      .send({ resolution_note: 'Manually corrected a bad seed row.' });

    expect(response.status).toBe(200);
    expect(response.body.resolved_by).toBe(admin.userId);
    expect(response.body.resolution_note).toBe('Manually corrected a bad seed row.');
  });

  it('never auto-resolves twice', async () => {
    const admin = await seedAdminUser(db);
    const discrepancyId = await createOpenDiscrepancy();
    const client = request.agent(testApp.app.getHttpServer());
    await client.post('/v1/auth/login').send({ email: admin.email, password: admin.password });

    await client.post(`/v1/admin/reconciliation-discrepancies/${discrepancyId}/resolve`).send({ resolution_note: 'first' });
    const second = await client.post(`/v1/admin/reconciliation-discrepancies/${discrepancyId}/resolve`).send({ resolution_note: 'second' });
    expect(second.status).toBe(409);
  });
});
