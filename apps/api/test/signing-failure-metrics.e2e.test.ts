import type { DatabaseClient } from '@gateway/database';
import { createPrismaClient } from '@gateway/database';
import type { FinancialMetrics } from '@gateway/observability';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FINANCIAL_METRICS } from '../src/observability/financial-metrics.provider.js';
import { createTestApp, type TestApp } from './support/create-test-app.js';
import { seedAdminUser } from './support/seed-admin-user.js';

/**
 * Phase 16/C6's "signing failure" alert needs a metric that actually moves
 * when a real signing request is rejected - not just a counter that
 * compiles. This drives the same policy-rejection path
 * `admin-signing.e2e.test.ts` already proves returns a 400/422 over real
 * HTTP, and additionally asserts `gateway_signing_failures_total` (recorded
 * by `MetricsRecordingSigningAuditTrail`, wired in `signing.provider.ts`)
 * actually incremented.
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

function stageValue(metrics: FinancialMetrics, stage: string): Promise<number | undefined> {
  return metrics.signingFailures.get().then((m) => m.values.find((v) => v.labels.stage === stage)?.value);
}

describe('gateway_signing_failures_total', () => {
  it('increments for a request rejected by the destination allowlist', async () => {
    const financialMetrics = testApp.app.get<FinancialMetrics>(FINANCIAL_METRICS);
    const before = (await stageValue(financialMetrics, 'validation_failed')) ?? 0;

    const admin = await seedAdminUser(db);
    const client = await login(admin.email, admin.password);
    const response = await client.post('/v1/admin/signing/requests').send(validBody({ to_address: '0xnotallowed' }));
    expect(response.status).toBe(400);

    expect(await stageValue(financialMetrics, 'validation_failed')).toBe(before + 1);
  });

  it('increments for a request rejected by the amount ceiling', async () => {
    const financialMetrics = testApp.app.get<FinancialMetrics>(FINANCIAL_METRICS);
    const before = (await stageValue(financialMetrics, 'validation_failed')) ?? 0;

    const admin = await seedAdminUser(db);
    const client = await login(admin.email, admin.password);
    const response = await client.post('/v1/admin/signing/requests').send(validBody({ amount: '2000000' }));
    expect(response.status).toBe(422);

    expect(await stageValue(financialMetrics, 'validation_failed')).toBe(before + 1);
  });

  it('does not increment for a request that is accepted (still just PENDING_APPROVAL)', async () => {
    const financialMetrics = testApp.app.get<FinancialMetrics>(FINANCIAL_METRICS);
    const before = (await stageValue(financialMetrics, 'validation_failed')) ?? 0;

    const admin = await seedAdminUser(db);
    const client = await login(admin.email, admin.password);
    const response = await client.post('/v1/admin/signing/requests').send(validBody());
    expect(response.status).toBe(201);

    expect(await stageValue(financialMetrics, 'validation_failed')).toBe(before);
  });
});
