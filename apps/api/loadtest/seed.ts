import { randomBytes, randomUUID } from 'node:crypto';
import { createPrismaClient } from '@gateway/database';
import { newId } from '@gateway/shared';
import { signJwt } from '@gateway/security';
import { seedMerchantWithLogin } from '../test/support/seed-merchant-login.js';
import { writeFixture } from './fixture.js';

/**
 * Provisions everything the load-test scenarios read: a merchant, a real
 * API key, a login-capable dashboard user, a pre-signed session JWT, and a
 * pool of AVAILABLE payment addresses (invoice creation retires one address
 * per invoice - SPEC section 8 - so the pool must be sized for the run).
 *
 * Reuses `seedMerchantWithLogin` from the e2e test suite rather than
 * duplicating merchant/API-key/user setup - it is the same "isolated,
 * uniquely-named merchant" every e2e test already relies on.
 *
 * Requires the API server to already be listening (`pnpm dev:api` or
 * `pnpm --filter @gateway/api start`): the poll-target invoices are created
 * through the real `POST /v1/payment-invoices` endpoint, not inserted
 * directly, so they carry exactly the state that endpoint produces.
 */

const NETWORK = 'ethereum';
const ASSET = 'USDT';
const CURRENCY = 'USD';

const ADDRESS_COUNT = Number(process.env.LOADTEST_ADDRESS_COUNT ?? 3000);
const POLL_INVOICE_COUNT = Number(process.env.LOADTEST_POLL_INVOICE_COUNT ?? 200);
const API_BASE_URL = process.env.LOADTEST_API_URL ?? `http://127.0.0.1:${process.env.API_PORT ?? 4000}`;

function randomEvmAddress(): string {
  return `0x${randomBytes(20).toString('hex')}`;
}

async function waitForApi(baseUrl: string): Promise<void> {
  try {
    const response = await fetch(`${baseUrl}/v1/health`);
    if (!response.ok) throw new Error(`GET /v1/health returned ${response.status}`);
  } catch (error) {
    throw new Error(
      `API is not reachable at ${baseUrl} - start it first (pnpm dev:api) before seeding. Cause: ${(error as Error).message}`,
    );
  }
}

async function seedAddresses(
  db: ReturnType<typeof createPrismaClient>,
  merchantId: string,
  count: number,
): Promise<void> {
  const batchSize = 500;
  for (let offset = 0; offset < count; offset += batchSize) {
    const batch = Array.from({ length: Math.min(batchSize, count - offset) }, () => {
      const address = randomEvmAddress();
      return {
        id: newId('paymentAddress'),
        merchantId,
        network: NETWORK.toUpperCase() as never,
        address,
        addressNormalized: address.toLowerCase(),
        assetSymbol: ASSET,
        status: 'AVAILABLE' as never,
      };
    });
    await db.paymentAddress.createMany({ data: batch });
  }
}

async function seedPollInvoices(apiKeyPlaintext: string, count: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const response = await fetch(`${API_BASE_URL}/v1/payment-invoices`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKeyPlaintext}`,
        'idempotency-key': randomUUID(),
      },
      body: JSON.stringify({
        order_id: `loadtest-poll-${randomUUID()}`,
        amount: '10.00',
        currency: CURRENCY,
        asset: ASSET,
        network: NETWORK,
      }),
    });
    if (!response.ok) {
      throw new Error(`seeding poll invoice ${i + 1}/${count} failed: ${response.status} ${await response.text()}`);
    }
    const body = (await response.json()) as { id: string };
    ids.push(body.id);
  }
  return ids;
}

async function main(): Promise<void> {
  await waitForApi(API_BASE_URL);

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is not set');
  const jwtAccessSecret = process.env.JWT_ACCESS_SECRET;
  if (!jwtAccessSecret) throw new Error('JWT_ACCESS_SECRET is not set');

  const db = createPrismaClient({ databaseUrl });

  console.log(`Seeding merchant + API key + ${ADDRESS_COUNT} deposit addresses...`);
  const merchant = await seedMerchantWithLogin(db);

  await seedAddresses(db, merchant.merchantId, ADDRESS_COUNT);

  const accessToken = signJwt(
    { sub: merchant.userId, email: merchant.email, platform_role: 'USER' },
    jwtAccessSecret,
    {
      expiresInSeconds: 6 * 3600,
      issuer: process.env.JWT_ISSUER ?? 'crypto-payment-gateway',
      audience: process.env.JWT_AUDIENCE ?? 'gateway-dashboard',
    },
  );

  console.log(`Seeding ${POLL_INVOICE_COUNT} invoices for the public-polling scenario...`);
  const pollInvoiceIds = await seedPollInvoices(merchant.apiKeyPlaintext, POLL_INVOICE_COUNT);

  writeFixture({
    apiBaseUrl: API_BASE_URL,
    merchantId: merchant.merchantId,
    apiKeyPlaintext: merchant.apiKeyPlaintext,
    userId: merchant.userId,
    email: merchant.email,
    password: merchant.password,
    accessToken,
    network: NETWORK,
    asset: ASSET,
    currency: CURRENCY,
    seededAddressCount: ADDRESS_COUNT,
    pollInvoiceIds,
  });

  console.log(`Fixture written: merchant ${merchant.merchantId}, ${ADDRESS_COUNT} addresses, ${pollInvoiceIds.length} poll invoices.`);
  await db.$disconnect();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
