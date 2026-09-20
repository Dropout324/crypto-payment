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

async function createRequestedRefund(merchantId: string): Promise<string> {
  const invoiceId = newId('invoice');
  await db.invoice.create({
    data: {
      id: invoiceId,
      merchantId,
      orderId: `ORDER-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      requestedCurrency: 'USD',
      requestedDecimals: 2,
      requestedAmount: '100',
      paymentAsset: 'USDT',
      paymentDecimals: 6,
      network: 'ETHEREUM',
      cryptoAmount: '100000000',
      underpaymentPolicy: 'MANUAL_REVIEW',
      overpaymentPolicy: 'MANUAL_REVIEW',
      underpaymentToleranceBps: 0,
      overpaymentToleranceBps: 0,
      requiredConfirmations: 12,
      status: 'PAID',
      expiresAt: new Date(Date.now() + 900_000),
    },
  });

  const refundId = newId('refund');
  await db.refund.create({
    data: {
      id: refundId,
      invoiceId,
      merchantId,
      network: 'ETHEREUM',
      assetSymbol: 'USDT',
      assetDecimals: 6,
      amount: '100000000',
      destinationAddress: '0xabc',
      destinationAddressNormalized: '0xabc',
      requestedBy: 'test',
      status: 'REQUESTED',
    },
  });
  return refundId;
}

describe('POST /v1/admin/refunds/:id/approve', () => {
  it('approves a refund and records the approver', async () => {
    const admin = await seedAdminUser(db);
    const merchant = await seedMerchant(db);
    const refundId = await createRequestedRefund(merchant.merchantId);
    const client = request.agent(testApp.app.getHttpServer());
    await client.post('/v1/auth/login').send({ email: admin.email, password: admin.password });

    const response = await client.post(`/v1/admin/refunds/${refundId}/approve`).send();

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('APPROVED');
    expect(response.body.approved_by).toBe(admin.userId);

    const auditRow = await db.auditLog.findFirst({ where: { resourceId: refundId, action: 'refund.approved' } });
    expect(auditRow).toBeTruthy();
  });

  it('rejects a refund and records the rejecter', async () => {
    const admin = await seedAdminUser(db);
    const merchant = await seedMerchant(db);
    const refundId = await createRequestedRefund(merchant.merchantId);
    const client = request.agent(testApp.app.getHttpServer());
    await client.post('/v1/auth/login').send({ email: admin.email, password: admin.password });

    const response = await client.post(`/v1/admin/refunds/${refundId}/reject`).send();
    expect(response.status).toBe(200);
    expect(response.body.status).toBe('REJECTED');
    expect(response.body.rejected_by).toBe(admin.userId);
  });

  it('cannot approve a refund twice', async () => {
    const admin = await seedAdminUser(db);
    const merchant = await seedMerchant(db);
    const refundId = await createRequestedRefund(merchant.merchantId);
    const client = request.agent(testApp.app.getHttpServer());
    await client.post('/v1/auth/login').send({ email: admin.email, password: admin.password });

    await client.post(`/v1/admin/refunds/${refundId}/approve`).send();
    const second = await client.post(`/v1/admin/refunds/${refundId}/approve`).send();
    expect(second.status).toBe(409);
  });
});
