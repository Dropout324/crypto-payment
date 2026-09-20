import { newId } from '@gateway/shared';
import type { DatabaseClient } from '@gateway/database';
import { createPrismaClient } from '@gateway/database';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../support/create-test-app.js';
import { seedAdminUser } from '../support/seed-admin-user.js';
import { seedMerchant } from '../support/seed-merchant.js';
import { seedMerchantWithLogin, type SeededMerchantLogin } from '../support/seed-merchant-login.js';

/**
 * Broken access control (OWASP API1/API3/API5) regression sweep.
 *
 * Most individual feature e2e suites already assert their own controller's
 * authorization (see e.g. merchant-api-keys, merchant-members,
 * admin-merchants). Two gaps were not covered by any of them:
 *
 * 1. Three admin write/read endpoints (reconciliation resolve, refund
 *    approve/reject, settlement listing) had no test asserting an
 *    under-privileged platform role is actually rejected - only the
 *    happy path was exercised. The permission wiring in `permissions.ts` is
 *    correct today; these tests exist so a future edit that drops a
 *    `@RequirePlatformPermission` decorator fails CI instead of shipping.
 * 2. "Resource-ID confusion": a merchant sending its OWN valid
 *    `X-Merchant-Id` header (so `MerchantRoleGuard` passes) but a resource id
 *    belonging to a DIFFERENT merchant. This is a distinct bug class from
 *    header spoofing (already covered elsewhere) - it tests that each
 *    service's `findFirst({ id, merchantId })` ownership check, not just the
 *    header check, is what is actually gating access.
 */

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

async function loggedInAgent(user: { email: string; password: string }) {
  const client = request.agent(testApp.app.getHttpServer());
  const login = await client.post('/v1/auth/login').send({ email: user.email, password: user.password });
  expect(login.status).toBe(200);
  return client;
}

async function loggedInMerchantAgent(merchant: SeededMerchantLogin) {
  return loggedInAgent(merchant);
}

describe('admin platform-role gating (negative cases)', () => {
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

  it('rejects SUPPORT and COMPLIANCE_OFFICER from resolving a reconciliation discrepancy (ADMIN-only)', async () => {
    for (const role of ['SUPPORT', 'COMPLIANCE_OFFICER'] as const) {
      const admin = await seedAdminUser(db, role);
      const discrepancyId = await createOpenDiscrepancy();
      const client = await loggedInAgent(admin);

      const response = await client
        .post(`/v1/admin/reconciliation-discrepancies/${discrepancyId}/resolve`)
        .send({ resolution_note: 'should not be allowed' });

      expect(response.status).toBe(403);
    }
  });

  it('rejects a plain USER platform role from even reading reconciliation discrepancies', async () => {
    const user = await seedAdminUser(db, 'SUPPORT');
    await db.user.update({ where: { id: user.userId }, data: { platformRole: 'USER' } });
    const client = await loggedInAgent(user);

    const response = await client.get('/v1/admin/reconciliation-discrepancies');
    expect(response.status).toBe(403);
  });

  it('rejects SUPPORT from approving or rejecting a refund (ADMIN-only decision)', async () => {
    const support = await seedAdminUser(db, 'SUPPORT');
    const merchant = await seedMerchant(db);
    const client = await loggedInAgent(support);

    const refundId1 = await createRequestedRefund(merchant.merchantId);
    const approve = await client.post(`/v1/admin/refunds/${refundId1}/approve`).send();
    expect(approve.status).toBe(403);

    const refundId2 = await createRequestedRefund(merchant.merchantId);
    const reject = await client.post(`/v1/admin/refunds/${refundId2}/reject`).send();
    expect(reject.status).toBe(403);
  });

  it('rejects a plain USER platform role from listing settlements', async () => {
    const user = await seedAdminUser(db, 'SUPPORT');
    await db.user.update({ where: { id: user.userId }, data: { platformRole: 'USER' } });
    const client = await loggedInAgent(user);

    const response = await client.get('/v1/admin/settlements');
    expect(response.status).toBe(403);
  });
});

describe('resource-ID confusion across merchants (correct own header, foreign resource id)', () => {
  it('404s updating a webhook endpoint that belongs to a different merchant', async () => {
    const owner = await seedMerchantWithLogin(db);
    const intruder = await seedMerchantWithLogin(db);
    const ownerClient = await loggedInMerchantAgent(owner);
    const intruderClient = await loggedInMerchantAgent(intruder);

    const created = await ownerClient
      .post('/v1/merchant/me/webhook-endpoints')
      .set('X-Merchant-Id', owner.merchantId)
      .send({ url: 'https://merchant.example.com/webhooks' });
    expect(created.status).toBe(201);

    const patch = await intruderClient
      .patch(`/v1/merchant/me/webhook-endpoints/${created.body.id}`)
      .set('X-Merchant-Id', intruder.merchantId) // intruder's OWN, valid header
      .send({ enabled: false });
    expect(patch.status).toBe(404);

    const rotate = await intruderClient
      .post(`/v1/merchant/me/webhook-endpoints/${created.body.id}/rotate-secret`)
      .set('X-Merchant-Id', intruder.merchantId)
      .send();
    expect(rotate.status).toBe(404);

    // The endpoint must be untouched by the intruder's attempts.
    const stillIntact = await ownerClient
      .get('/v1/merchant/me/webhook-endpoints')
      .set('X-Merchant-Id', owner.merchantId);
    expect(stillIntact.body.find((e: { id: string }) => e.id === created.body.id).enabled).toBe(true);
  });

  it('404s revoking an API key that belongs to a different merchant', async () => {
    const owner = await seedMerchantWithLogin(db);
    const intruder = await seedMerchantWithLogin(db);
    const ownerClient = await loggedInMerchantAgent(owner);
    const intruderClient = await loggedInMerchantAgent(intruder);

    const ownerKeys = await ownerClient.get('/v1/merchant/me/api-keys').set('X-Merchant-Id', owner.merchantId);
    const ownerKeyId = ownerKeys.body[0].id;

    const revoke = await intruderClient
      .post(`/v1/merchant/me/api-keys/${ownerKeyId}/revoke`)
      .set('X-Merchant-Id', intruder.merchantId)
      .send();
    expect(revoke.status).toBe(404);

    const stillActive = await db.apiKey.findUniqueOrThrow({ where: { id: ownerKeyId } });
    expect(stillActive.status).toBe('ACTIVE');
  });

  it("404s changing another merchant's member role even with the intruder's own valid header", async () => {
    const owner = await seedMerchantWithLogin(db);
    const intruder = await seedMerchantWithLogin(db);
    const ownerClient = await loggedInMerchantAgent(owner);
    const intruderClient = await loggedInMerchantAgent(intruder);

    const ownerMembers = await ownerClient.get('/v1/merchant/me/members').set('X-Merchant-Id', owner.merchantId);
    const ownerMemberId = ownerMembers.body[0].id;

    const response = await intruderClient
      .patch(`/v1/merchant/me/members/${ownerMemberId}`)
      .set('X-Merchant-Id', intruder.merchantId)
      .send({ role: 'VIEWER' });
    expect(response.status).toBe(404);
  });
});

describe('dashboard access after merchant suspension (Phase 17 pass 1, ADR 0031)', () => {
  /**
   * Before `MerchantRoleGuard` checked `merchant.status`, this only stopped
   * `ApiKeyGuard`-authenticated traffic (`api-key-lifecycle.e2e.test.ts`'s
   * "rejects a key belonging to a suspended merchant") - a suspended
   * merchant's dashboard users, authenticated by JWT instead of an API key,
   * kept full access for as long as they kept their session alive. This
   * proves the same suspension now blocks the dashboard path too, and
   * immediately (no access-token TTL to wait out), because this guard
   * re-checks the database on every request rather than trusting a claim
   * baked into the JWT at login time.
   */
  it('blocks a dashboard request for a merchant that was suspended after the session was issued', async () => {
    const merchant = await seedMerchantWithLogin(db);
    const client = await loggedInMerchantAgent(merchant);

    const before = await client.get('/v1/merchant/me/settings').set('X-Merchant-Id', merchant.merchantId);
    expect(before.status).toBe(200);

    await db.merchant.update({ where: { id: merchant.merchantId }, data: { status: 'SUSPENDED' } });

    const after = await client.get('/v1/merchant/me/settings').set('X-Merchant-Id', merchant.merchantId);
    expect(after.status).toBe(403);
  });

  it('restores dashboard access once the merchant is reactivated', async () => {
    const merchant = await seedMerchantWithLogin(db);
    await db.merchant.update({ where: { id: merchant.merchantId }, data: { status: 'SUSPENDED' } });
    const client = await loggedInMerchantAgent(merchant);

    const whileSuspended = await client.get('/v1/merchant/me/settings').set('X-Merchant-Id', merchant.merchantId);
    expect(whileSuspended.status).toBe(403);

    await db.merchant.update({ where: { id: merchant.merchantId }, data: { status: 'ACTIVE' } });

    const afterReactivation = await client.get('/v1/merchant/me/settings').set('X-Merchant-Id', merchant.merchantId);
    expect(afterReactivation.status).toBe(200);
  });
});
