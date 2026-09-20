import { newId } from '@gateway/shared';
import type { DatabaseClient } from '@gateway/database';
import { createPrismaClient } from '@gateway/database';
import { EnvKeyProvider, encryptSecret } from '@gateway/security';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from './support/create-test-app.js';
import { seedMerchant } from './support/seed-merchant.js';

let testApp: TestApp;
let db: DatabaseClient;
const keyProvider = new EnvKeyProvider();

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

async function createEndpoint(merchantId: string, url: string): Promise<string> {
  const id = newId('webhookEndpoint');
  const secret = 'whsec_test_secret';
  await db.webhookEndpoint.create({
    data: {
      id,
      merchantId,
      url,
      eventTypes: [],
      secretEncrypted: encryptSecret(secret, keyProvider),
      secretFingerprint: secret.slice(0, 8),
      enabled: true,
    },
  });
  return id;
}

describe('POST /v1/webhooks/test', () => {
  it('refuses to deliver to a private-network URL', async () => {
    const merchant = await seedMerchant(db);
    const endpointId = await createEndpoint(merchant.merchantId, 'http://127.0.0.1:9/hook');

    const response = await server()
      .post('/v1/webhooks/test')
      .set('Authorization', `Bearer ${merchant.apiKeyPlaintext}`)
      .send({ endpoint_id: endpointId });

    expect(response.status).toBe(200);
    expect(response.body.delivered).toBe(false);
    expect(response.body.error).toMatch(/private/i);
  });

  it("404s for another merchant's endpoint", async () => {
    const owner = await seedMerchant(db);
    const stranger = await seedMerchant(db);
    const endpointId = await createEndpoint(owner.merchantId, 'https://example.com/hook');

    const response = await server()
      .post('/v1/webhooks/test')
      .set('Authorization', `Bearer ${stranger.apiKeyPlaintext}`)
      .send({ endpoint_id: endpointId });

    expect(response.status).toBe(404);
  });

  it('404s for an unknown endpoint id', async () => {
    const merchant = await seedMerchant(db);
    const response = await server()
      .post('/v1/webhooks/test')
      .set('Authorization', `Bearer ${merchant.apiKeyPlaintext}`)
      .send({ endpoint_id: 'whe_does_not_exist' });

    expect(response.status).toBe(404);
  });

  it('rejects an unauthenticated request', async () => {
    const response = await server().post('/v1/webhooks/test').send({ endpoint_id: 'whe_x' });
    expect(response.status).toBe(401);
  });
});
