import { randomUUID } from 'node:crypto';
import type { DatabaseClient } from '@gateway/database';
import { createPrismaClient } from '@gateway/database';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../support/create-test-app.js';
import { seedDepositAddress, seedMerchant } from '../support/seed-merchant.js';

/**
 * `ApiKey.livemode` was set at creation and returned in every response but
 * never checked against the network a request actually named (Phase 17
 * pass 1 known gap) - a test-mode key could create a mainnet invoice, and a
 * live key could presumably touch a testnet. `assertNetworkMatchesLivemode`
 * (packages/shared/src/domain/network.ts), called from both
 * `invoices.service.ts` and `addresses.service.ts`, is what closes it; this
 * proves both directions actually reject, for both endpoints.
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

function server() {
  return request(testApp.app.getHttpServer());
}

function randomEvmAddress() {
  return `0x${randomUUID().replace(/-/g, '')}`.slice(0, 42);
}

async function createInvoice(apiKeyPlaintext: string, network: string, asset = 'USDT') {
  return server()
    .post('/v1/payment-invoices')
    .set('Authorization', `Bearer ${apiKeyPlaintext}`)
    .set('Idempotency-Key', randomUUID())
    .send({ order_id: `ORDER-${randomUUID()}`, amount: '100.00', currency: 'USD', asset, network });
}

async function registerAddress(apiKeyPlaintext: string, network: string, asset = 'USDT') {
  return server()
    .post('/v1/merchant/addresses')
    .set('Authorization', `Bearer ${apiKeyPlaintext}`)
    .send({ network, asset, address: randomEvmAddress() });
}

describe('test/live key and network separation', () => {
  it('rejects a test-mode key creating an invoice on a mainnet network', async () => {
    const merchant = await seedMerchant(db, { livemode: false });
    await seedDepositAddress(db, { merchantId: merchant.merchantId, network: 'ETHEREUM', asset: 'USDT', address: randomEvmAddress() });

    const response = await createInvoice(merchant.apiKeyPlaintext, 'ethereum');

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('network_livemode_mismatch');
  });

  it('rejects a live key creating an invoice on a testnet network', async () => {
    const merchant = await seedMerchant(db, { livemode: true });
    await seedDepositAddress(db, {
      merchantId: merchant.merchantId,
      network: 'ETHEREUM_SEPOLIA',
      asset: 'USDT',
      address: randomEvmAddress(),
    });

    const response = await createInvoice(merchant.apiKeyPlaintext, 'ethereum_sepolia');

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('network_livemode_mismatch');
  });

  it('allows a test-mode key to create an invoice on a testnet network', async () => {
    const merchant = await seedMerchant(db, { livemode: false });
    await seedDepositAddress(db, {
      merchantId: merchant.merchantId,
      network: 'ETHEREUM_SEPOLIA',
      asset: 'ETH',
      address: randomEvmAddress(),
    });

    // Sepolia only has a native-ETH test asset configured - USDT does not
    // exist there (packages/shared/src/domain/asset.ts), unlike mainnet
    // Ethereum used by the rest of this file.
    const response = await createInvoice(merchant.apiKeyPlaintext, 'ethereum_sepolia', 'ETH');

    expect(response.status).toBe(201);
  });

  it('allows a live key to create an invoice on a mainnet network', async () => {
    const merchant = await seedMerchant(db, { livemode: true });
    await seedDepositAddress(db, { merchantId: merchant.merchantId, network: 'ETHEREUM', asset: 'USDT', address: randomEvmAddress() });

    const response = await createInvoice(merchant.apiKeyPlaintext, 'ethereum');

    expect(response.status).toBe(201);
  });

  it('rejects a test-mode key registering a mainnet deposit address', async () => {
    const merchant = await seedMerchant(db, { livemode: false });

    const response = await registerAddress(merchant.apiKeyPlaintext, 'ethereum');

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('network_livemode_mismatch');
  });

  it('rejects a live key registering a testnet deposit address', async () => {
    const merchant = await seedMerchant(db, { livemode: true });

    const response = await registerAddress(merchant.apiKeyPlaintext, 'ethereum_sepolia');

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('network_livemode_mismatch');
  });
});
