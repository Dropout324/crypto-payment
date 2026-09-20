import { newId } from '@gateway/shared';
import type { DatabaseClient } from '@gateway/database';
import { createPrismaClient } from '@gateway/database';
import { hashPassword } from '@gateway/security';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from './support/create-test-app.js';
import { seedMerchantWithLogin, type SeededMerchantLogin } from './support/seed-merchant-login.js';

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

async function loggedInAgent(email: string, password: string) {
  const client = request.agent(testApp.app.getHttpServer());
  const login = await client.post('/v1/auth/login').send({ email, password });
  expect(login.status).toBe(200);
  return client;
}

async function ownerAgent(merchant: SeededMerchantLogin) {
  return loggedInAgent(merchant.email, merchant.password);
}

/** A fresh, login-capable user not yet a member of any merchant. */
async function createUser(): Promise<{ userId: string; email: string; password: string }> {
  const userId = newId('user');
  const email = `member-${userId}@example.test`.toLowerCase();
  const password = 'MemberPassword1!';
  await db.user.create({
    data: { id: userId, email, passwordHash: await hashPassword(password), platformRole: 'USER', status: 'ACTIVE' },
  });
  return { userId, email, password };
}

async function addMember(merchantId: string, role: 'OWNER' | 'ADMIN' | 'DEVELOPER' | 'VIEWER') {
  const user = await createUser();
  await db.merchantMember.create({ data: { id: newId('merchantMember'), merchantId, userId: user.userId, role } });
  return user;
}

describe('merchant member management', () => {
  it('the owner can list, add, change the role of, and remove a member', async () => {
    const merchant = await seedMerchantWithLogin(db);
    const client = await ownerAgent(merchant);
    const newUser = await createUser();

    const initialList = await client.get('/v1/merchant/me/members').set('X-Merchant-Id', merchant.merchantId);
    expect(initialList.status).toBe(200);
    expect(initialList.body).toHaveLength(1);
    expect(initialList.body[0].role).toBe('OWNER');

    const added = await client
      .post('/v1/merchant/me/members')
      .set('X-Merchant-Id', merchant.merchantId)
      .send({ email: newUser.email, role: 'DEVELOPER' });
    expect(added.status).toBe(201);
    expect(added.body.role).toBe('DEVELOPER');
    expect(added.body.email).toBe(newUser.email);

    const changed = await client
      .patch(`/v1/merchant/me/members/${added.body.id}`)
      .set('X-Merchant-Id', merchant.merchantId)
      .send({ role: 'ADMIN' });
    expect(changed.status).toBe(200);
    expect(changed.body.role).toBe('ADMIN');

    const removed = await client
      .delete(`/v1/merchant/me/members/${added.body.id}`)
      .set('X-Merchant-Id', merchant.merchantId);
    expect(removed.status).toBe(204);

    const finalList = await client.get('/v1/merchant/me/members').set('X-Merchant-Id', merchant.merchantId);
    expect(finalList.body).toHaveLength(1);
  });

  it('rejects adding a user with no account, and rejects a duplicate membership', async () => {
    const merchant = await seedMerchantWithLogin(db);
    const client = await ownerAgent(merchant);

    const noSuchUser = await client
      .post('/v1/merchant/me/members')
      .set('X-Merchant-Id', merchant.merchantId)
      .send({ email: 'nobody-with-this-email@example.test', role: 'VIEWER' });
    expect(noSuchUser.status).toBe(404);

    const newUser = await createUser();
    await client.post('/v1/merchant/me/members').set('X-Merchant-Id', merchant.merchantId).send({ email: newUser.email, role: 'VIEWER' });

    const duplicate = await client
      .post('/v1/merchant/me/members')
      .set('X-Merchant-Id', merchant.merchantId)
      .send({ email: newUser.email, role: 'VIEWER' });
    expect(duplicate.status).toBe(409);
  });

  it('refuses to demote or remove the last remaining owner', async () => {
    const merchant = await seedMerchantWithLogin(db);
    const client = await ownerAgent(merchant);

    const ownerMember = await db.merchantMember.findFirstOrThrow({
      where: { merchantId: merchant.merchantId, role: 'OWNER' },
    });

    const demote = await client
      .patch(`/v1/merchant/me/members/${ownerMember.id}`)
      .set('X-Merchant-Id', merchant.merchantId)
      .send({ role: 'ADMIN' });
    expect(demote.status).toBe(409);

    const remove = await client
      .delete(`/v1/merchant/me/members/${ownerMember.id}`)
      .set('X-Merchant-Id', merchant.merchantId);
    expect(remove.status).toBe(409);
  });

  it('a VIEWER and a DEVELOPER can list members but not manage them', async () => {
    const merchant = await seedMerchantWithLogin(db);
    const viewer = await addMember(merchant.merchantId, 'VIEWER');
    const developer = await addMember(merchant.merchantId, 'DEVELOPER');

    for (const member of [viewer, developer]) {
      const client = await loggedInAgent(member.email, member.password);

      const list = await client.get('/v1/merchant/me/members').set('X-Merchant-Id', merchant.merchantId);
      expect(list.status).toBe(200);

      const add = await client
        .post('/v1/merchant/me/members')
        .set('X-Merchant-Id', merchant.merchantId)
        .send({ email: (await createUser()).email, role: 'VIEWER' });
      expect(add.status).toBe(403);
    }
  });

  it('a DEVELOPER can manage API keys and webhook endpoints, but a VIEWER cannot', async () => {
    const merchant = await seedMerchantWithLogin(db);
    const developer = await addMember(merchant.merchantId, 'DEVELOPER');
    const viewer = await addMember(merchant.merchantId, 'VIEWER');

    const devClient = await loggedInAgent(developer.email, developer.password);
    const devCreate = await devClient
      .post('/v1/merchant/me/api-keys')
      .set('X-Merchant-Id', merchant.merchantId)
      .send({ name: 'dev key' });
    expect(devCreate.status).toBe(201);

    const viewerClient = await loggedInAgent(viewer.email, viewer.password);
    const viewerCreate = await viewerClient
      .post('/v1/merchant/me/api-keys')
      .set('X-Merchant-Id', merchant.merchantId)
      .send({ name: 'viewer key' });
    expect(viewerCreate.status).toBe(403);
  });
});
