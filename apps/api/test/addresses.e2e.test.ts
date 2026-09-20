import { createHash, randomBytes } from 'node:crypto';
import type { DatabaseClient } from '@gateway/database';
import { createPrismaClient } from '@gateway/database';
import { toChecksumAddress } from '@gateway/blockchain';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from './support/create-test-app.js';
import { seedMerchant } from './support/seed-merchant.js';

/**
 * `payment_addresses` enforces global uniqueness per (network, address) - one
 * real-world address cannot belong to two merchants - so tests that each
 * expect a successful registration need a FRESH address, not the same famous
 * example reused across cases. This mints a fresh valid mainnet P2PKH address
 * per call.
 */
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function sha256(data: Buffer): Buffer {
  return createHash('sha256').update(data).digest();
}
function freshBitcoinAddress(): string {
  const payload = Buffer.concat([Buffer.from([0x00]), randomBytes(20)]);
  const checksum = sha256(sha256(payload)).subarray(0, 4);
  const full = Buffer.concat([payload, checksum]);

  let value = BigInt(`0x${full.toString('hex')}`);
  let out = '';
  while (value > 0n) {
    out = BASE58_ALPHABET[Number(value % 58n)] + out;
    value /= 58n;
  }

  // The payload always starts with the 0x00 version byte, and BigInt has no
  // concept of a "leading zero byte" - it just disappears from the numeric
  // value. Base58Check instead encodes each leading zero BYTE as a leading
  // '1' CHARACTER; without restoring it, the address decodes one byte short
  // and fails length validation.
  let leadingZeroBytes = 0;
  for (const byte of full) {
    if (byte !== 0) break;
    leadingZeroBytes += 1;
  }
  return '1'.repeat(leadingZeroBytes) + out;
}
function freshEvmAddress(): string {
  return `0x${randomBytes(20).toString('hex')}`;
}

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

describe('POST /v1/merchant/addresses', () => {
  it('registers a valid checksummed EVM address', async () => {
    const merchant = await seedMerchant(db);
    // A fresh address each run (the DB is not wiped between test runs, so a
    // fixed literal would collide with a row a previous run already inserted).
    const address = toChecksumAddress(freshEvmAddress());

    const response = await server()
      .post('/v1/merchant/addresses')
      .set('Authorization', `Bearer ${merchant.apiKeyPlaintext}`)
      .send({ network: 'ethereum', asset: 'USDT', address });

    expect(response.status).toBe(201);
    expect(response.body.status).toBe('AVAILABLE');
    expect(response.body.address).toBe(address);
  });

  it('accepts an unchecksummed (all-lowercase) EVM address', async () => {
    const merchant = await seedMerchant(db);
    // A fresh address, not the one from the previous test: after
    // normalization both cases of the same address collide on the
    // (network, address) uniqueness constraint, and that collision is
    // covered separately below - this test is specifically about casing.
    const response = await server()
      .post('/v1/merchant/addresses')
      .set('Authorization', `Bearer ${merchant.apiKeyPlaintext}`)
      .send({ network: 'ethereum', asset: 'USDT', address: freshEvmAddress().toLowerCase() });

    expect(response.status).toBe(201);
  });

  it('rejects an EVM address with a broken checksum', async () => {
    const merchant = await seedMerchant(db);
    // Same address as the valid test above with one character's case flipped.
    const response = await server()
      .post('/v1/merchant/addresses')
      .set('Authorization', `Bearer ${merchant.apiKeyPlaintext}`)
      .send({ network: 'ethereum', asset: 'USDT', address: '0x5aAeb6053f3E94C9b9A09f33669435E7Ef1BeAed' });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('invalid_address');
  });

  it('rejects a structurally malformed EVM address', async () => {
    const merchant = await seedMerchant(db);
    const response = await server()
      .post('/v1/merchant/addresses')
      .set('Authorization', `Bearer ${merchant.apiKeyPlaintext}`)
      .send({ network: 'ethereum', asset: 'USDT', address: 'not-an-address' });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('invalid_address');
  });

  it('registers a valid Bitcoin address on Bitcoin', async () => {
    const merchant = await seedMerchant(db);
    const response = await server()
      .post('/v1/merchant/addresses')
      .set('Authorization', `Bearer ${merchant.apiKeyPlaintext}`)
      .send({ network: 'bitcoin', asset: 'BTC', address: freshBitcoinAddress() });

    expect(response.status).toBe(201);
  });

  it('rejects an Ethereum address submitted for Bitcoin', async () => {
    const merchant = await seedMerchant(db);
    const response = await server()
      .post('/v1/merchant/addresses')
      .set('Authorization', `Bearer ${merchant.apiKeyPlaintext}`)
      .send({ network: 'bitcoin', asset: 'BTC', address: '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed' });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('invalid_address');
  });

  it('rejects an unsupported asset for the network', async () => {
    const merchant = await seedMerchant(db);
    const response = await server()
      .post('/v1/merchant/addresses')
      .set('Authorization', `Bearer ${merchant.apiKeyPlaintext}`)
      .send({ network: 'bitcoin', asset: 'USDT', address: '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa' });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('unsupported_asset');
  });

  it('rejects re-registering the same address twice for one merchant', async () => {
    const merchant = await seedMerchant(db);
    const address = freshEvmAddress();
    const first = await server()
      .post('/v1/merchant/addresses')
      .set('Authorization', `Bearer ${merchant.apiKeyPlaintext}`)
      .send({ network: 'ethereum', asset: 'USDT', address });
    expect(first.status).toBe(201);

    const second = await server()
      .post('/v1/merchant/addresses')
      .set('Authorization', `Bearer ${merchant.apiKeyPlaintext}`)
      .send({ network: 'ethereum', asset: 'USDT', address });
    expect(second.status).toBe(409);
  });

  it('rejects an unauthenticated request', async () => {
    const response = await server()
      .post('/v1/merchant/addresses')
      .send({ network: 'ethereum', asset: 'USDT', address: '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed' });
    expect(response.status).toBe(401);
  });
});

describe('GET /v1/merchant/addresses', () => {
  it('lists only the calling merchant\'s addresses', async () => {
    const merchantA = await seedMerchant(db);
    const merchantB = await seedMerchant(db);

    await server()
      .post('/v1/merchant/addresses')
      .set('Authorization', `Bearer ${merchantA.apiKeyPlaintext}`)
      .send({ network: 'ethereum', asset: 'USDT', address: freshEvmAddress() });
    await server()
      .post('/v1/merchant/addresses')
      .set('Authorization', `Bearer ${merchantB.apiKeyPlaintext}`)
      .send({ network: 'ethereum', asset: 'USDT', address: freshEvmAddress() });

    const response = await server().get('/v1/merchant/addresses').set('Authorization', `Bearer ${merchantA.apiKeyPlaintext}`);

    expect(response.status).toBe(200);
    expect(response.body).toHaveLength(1);
  });

  it('filters by network', async () => {
    const merchant = await seedMerchant(db);
    await server()
      .post('/v1/merchant/addresses')
      .set('Authorization', `Bearer ${merchant.apiKeyPlaintext}`)
      .send({ network: 'ethereum', asset: 'USDT', address: freshEvmAddress() });
    await server()
      .post('/v1/merchant/addresses')
      .set('Authorization', `Bearer ${merchant.apiKeyPlaintext}`)
      .send({ network: 'bitcoin', asset: 'BTC', address: freshBitcoinAddress() });

    const response = await server()
      .get('/v1/merchant/addresses?network=bitcoin')
      .set('Authorization', `Bearer ${merchant.apiKeyPlaintext}`);

    expect(response.status).toBe(200);
    expect(response.body).toHaveLength(1);
    expect(response.body[0].network).toBe('BITCOIN');
  });
});
