import { Money } from '@gateway/shared';
import type { DatabaseClient } from '@gateway/database';
import { createPrismaClient, runInTransaction } from '@gateway/database';
import { postPaymentCredit } from '@gateway/ledger';
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

describe('GET /v1/merchant/balance', () => {
  it('reflects a posted ledger credit, net of the merchant fee', async () => {
    const merchant = await seedMerchant(db);
    const transfer = await seedCreditedTransfer(db, { merchantId: merchant.merchantId, amountUnits: 100_000_000n });

    await runInTransaction(db, (tx) =>
      postPaymentCredit(tx, {
        merchantId: merchant.merchantId,
        invoiceId: transfer.invoiceId,
        tokenTransferId: transfer.transferId,
        network: 'ETHEREUM',
        assetSymbol: 'USDT',
        assetDecimals: 6,
        grossAmount: Money.fromUnits(100_000_000n, 'USDT', 6),
        feeBps: 100, // 1%
        idempotencyKey: `credit:ETHEREUM:${transfer.txHash}:0`,
      }),
    );

    const response = await server()
      .get('/v1/merchant/balance')
      .set('Authorization', `Bearer ${merchant.apiKeyPlaintext}`);

    expect(response.status).toBe(200);
    expect(response.body.balances).toEqual(
      expect.arrayContaining([expect.objectContaining({ network: 'ETHEREUM', asset: 'USDT', available: '99.000000' })]),
    );
  });

  it('returns no balances for a merchant with no postings', async () => {
    const merchant = await seedMerchant(db);
    const response = await server().get('/v1/merchant/balance').set('Authorization', `Bearer ${merchant.apiKeyPlaintext}`);

    expect(response.status).toBe(200);
    expect(response.body.balances).toEqual([]);
  });

  it('filters by network and asset', async () => {
    const merchant = await seedMerchant(db);
    const transfer = await seedCreditedTransfer(db, { merchantId: merchant.merchantId, amountUnits: 50_000_000n });

    await runInTransaction(db, (tx) =>
      postPaymentCredit(tx, {
        merchantId: merchant.merchantId,
        invoiceId: transfer.invoiceId,
        tokenTransferId: transfer.transferId,
        network: 'ETHEREUM',
        assetSymbol: 'USDT',
        assetDecimals: 6,
        grossAmount: Money.fromUnits(50_000_000n, 'USDT', 6),
        feeBps: 0,
        idempotencyKey: `credit:ETHEREUM:${transfer.txHash}:0`,
      }),
    );

    const wrongNetwork = await server()
      .get('/v1/merchant/balance')
      .query({ network: 'polygon' })
      .set('Authorization', `Bearer ${merchant.apiKeyPlaintext}`);
    expect(wrongNetwork.body.balances).toEqual([]);

    const rightFilter = await server()
      .get('/v1/merchant/balance')
      .query({ network: 'ethereum', asset: 'usdt' })
      .set('Authorization', `Bearer ${merchant.apiKeyPlaintext}`);
    expect(rightFilter.body.balances).toHaveLength(1);
  });

  it('rejects an unsupported network filter', async () => {
    const merchant = await seedMerchant(db);
    const response = await server()
      .get('/v1/merchant/balance')
      .query({ network: 'dogecoin' })
      .set('Authorization', `Bearer ${merchant.apiKeyPlaintext}`);

    expect(response.status).toBe(400);
  });
});
