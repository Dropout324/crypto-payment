import type { DatabaseClient } from '@gateway/database';
import { createPrismaClient } from '@gateway/database';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from './support/create-test-app.js';
import { seedAdminUser } from './support/seed-admin-user.js';

/**
 * Phase 12 (KMS/HSM signing, C2): proves the durable, audited policy engine
 * end to end through the real HTTP + Postgres stack, not just
 * `packages/signing`'s own unit tests. Runs with a real allowlist/ceiling
 * configured and `SIGNING_BACKEND` left at its default (`disabled`) - the
 * point of the last few tests below is exactly that a request can be
 * durably submitted, approved twice by distinct approvers, and *still*
 * never produce a signature, because Mode A (custodial signing) is not
 * live. See ADR 0026.
 */
let testApp: TestApp;
let db: DatabaseClient;

const ALLOWED_DESTINATION = '0xdeadbeef00000000000000000000000000000dead';

beforeAll(async () => {
  testApp = await createTestApp({
    configOverrides: {
      signingAllowedDestinations: [ALLOWED_DESTINATION.toLowerCase()],
      signingMaxAmountPerTx: 1_000_000n,
      signingMaxAmountPerWindow: 5_000_000n,
      signingWindowSeconds: 3600,
      signingRequiredApprovals: 2,
    },
  });
  db = createPrismaClient();
  await db.$connect();
});

afterAll(async () => {
  await testApp.close();
  await db.$disconnect();
});

async function login(email: string, password: string) {
  const client = request.agent(testApp.app.getHttpServer());
  await client.post('/v1/auth/login').send({ email, password });
  return client;
}

function validBody(overrides: Partial<Record<string, string>> = {}) {
  return {
    merchant_id: 'mch_test',
    network: 'ETHEREUM',
    asset: 'USDT',
    from_address: '0xhotwallet',
    to_address: ALLOWED_DESTINATION,
    amount: '500000',
    ...overrides,
  };
}

describe('POST /v1/admin/signing/requests', () => {
  it('rejects a destination not on the configured allowlist', async () => {
    const admin = await seedAdminUser(db);
    const client = await login(admin.email, admin.password);

    const response = await client.post('/v1/admin/signing/requests').send(validBody({ to_address: '0xnotallowed' }));

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('validation_failed');
  });

  it('rejects an amount over the configured per-transaction ceiling', async () => {
    const admin = await seedAdminUser(db);
    const client = await login(admin.email, admin.password);

    const response = await client.post('/v1/admin/signing/requests').send(validBody({ amount: '2000000' }));

    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe('signing_ceiling_exceeded');
  });

  it('creates a durable PENDING_APPROVAL request when requiredApprovals is 2', async () => {
    const admin = await seedAdminUser(db);
    const client = await login(admin.email, admin.password);

    const response = await client.post('/v1/admin/signing/requests').send(validBody());

    expect(response.status).toBe(201);
    expect(response.body.status).toBe('PENDING_APPROVAL');
    expect(response.body.approvals).toEqual([]);

    // Persisted in Postgres, not just held in the Nest provider's memory.
    const row = await db.signingApprovalRequest.findUnique({ where: { id: response.body.id } });
    expect(row).toBeTruthy();
    expect(row?.status).toBe('PENDING_APPROVAL');

    const auditRow = await db.auditLog.findFirst({
      where: { resourceType: 'signing_request', resourceId: response.body.id, action: 'signing_request.submitted' },
    });
    expect(auditRow).toBeTruthy();
  });

  it('is refused with a 403 by a role without signing:decide (SUPPORT can read, not submit)', async () => {
    const support = await seedAdminUser(db, 'SUPPORT');
    const client = await login(support.email, support.password);

    const listResponse = await client.get('/v1/admin/signing/requests');
    expect(listResponse.status).toBe(200);

    const submitResponse = await client.post('/v1/admin/signing/requests').send(validBody());
    expect(submitResponse.status).toBe(403);
  });
});

describe('the full submit -> approve -> approve lifecycle', () => {
  it('requires two distinct, non-requester approvals, then fails closed because no real signing backend is configured', async () => {
    const requester = await seedAdminUser(db);
    const approver1 = await seedAdminUser(db);
    const approver2 = await seedAdminUser(db);
    const requesterClient = await login(requester.email, requester.password);
    const approver1Client = await login(approver1.email, approver1.password);
    const approver2Client = await login(approver2.email, approver2.password);

    const submitted = await requesterClient.post('/v1/admin/signing/requests').send(validBody());
    const requestId = submitted.body.id;

    // The requester cannot also approve their own request.
    const selfApprove = await requesterClient.post(`/v1/admin/signing/requests/${requestId}/approve`).send();
    expect(selfApprove.status).toBe(403);

    const firstApproval = await approver1Client.post(`/v1/admin/signing/requests/${requestId}/approve`).send();
    expect(firstApproval.status).toBe(200);
    expect(firstApproval.body.status).toBe('PENDING_APPROVAL');
    expect(firstApproval.body.approvals).toEqual([approver1.userId]);

    // Crossing the required-approval threshold reaches the real (disabled)
    // backend and fails closed - proving no signature can be produced
    // without a real KMS/HSM configured, even after full policy sign-off.
    const secondApproval = await approver2Client.post(`/v1/admin/signing/requests/${requestId}/approve`).send();
    expect(secondApproval.status).toBe(422);
    expect(secondApproval.body.error.code).toBe('signing_not_configured');

    const auditActions = (
      await db.auditLog.findMany({ where: { resourceType: 'signing_request', resourceId: requestId }, orderBy: { createdAt: 'asc' } })
    ).map((row) => row.action);
    expect(auditActions).toEqual([
      'signing_request.submitted',
      'signing_request.approved',
      'signing_request.approved',
      'signing_request.sign_failed',
    ]);
  });

  it('rejects a pending request outright, recording the rejecter and reason, and blocks any later approval', async () => {
    const requester = await seedAdminUser(db);
    const approver = await seedAdminUser(db);
    const requesterClient = await login(requester.email, requester.password);
    const approverClient = await login(approver.email, approver.password);

    const submitted = await requesterClient.post('/v1/admin/signing/requests').send(validBody());
    const requestId = submitted.body.id;

    const rejected = await approverClient
      .post(`/v1/admin/signing/requests/${requestId}/reject`)
      .send({ reason: 'destination looks suspicious' });

    expect(rejected.status).toBe(200);
    expect(rejected.body.status).toBe('REJECTED');
    expect(rejected.body.rejected_by).toBe(approver.userId);
    expect(rejected.body.rejection_reason).toBe('destination looks suspicious');

    const lateApproval = await approverClient.post(`/v1/admin/signing/requests/${requestId}/approve`).send();
    expect(lateApproval.status).toBe(409);
  });

  it('404s for an unknown signing request id', async () => {
    const admin = await seedAdminUser(db);
    const client = await login(admin.email, admin.password);

    const response = await client.get('/v1/admin/signing/requests/never-existed');
    expect(response.status).toBe(404);
  });
});
