import type { DatabaseClient } from '@gateway/database';
import { createPrismaClient } from '@gateway/database';
import { hashPassword } from '@gateway/security';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from './support/create-test-app.js';
import { seedMerchant } from './support/seed-merchant.js';
import { seedUser } from './support/seed-user.js';

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

function agent() {
  return request.agent(testApp.app.getHttpServer());
}

function cookieNames(setCookieHeader: string[] | undefined): string[] {
  return (setCookieHeader ?? []).map((c) => c.split('=')[0]);
}

describe('POST /v1/auth/login', () => {
  it('logs in with valid credentials and sets both session cookies', async () => {
    const user = await seedUser(db);

    const response = await server().post('/v1/auth/login').send({ email: user.email, password: user.password });

    expect(response.status).toBe(200);
    expect(response.body.user).toMatchObject({ id: user.userId, email: user.email, platform_role: 'USER' });
    expect(cookieNames(response.headers['set-cookie'])).toEqual(expect.arrayContaining(['gw_access', 'gw_refresh']));
  });

  it('fails identically for an unknown email and a wrong password', async () => {
    const user = await seedUser(db);

    const unknown = await server().post('/v1/auth/login').send({ email: 'nobody@example.test', password: 'whatever123' });
    const wrong = await server().post('/v1/auth/login').send({ email: user.email, password: 'wrong-password' });

    expect(unknown.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(unknown.body.error.code).toBe(wrong.body.error.code);
    expect(unknown.body.error.message).toBe(wrong.body.error.message);
  });

  it('locks the account after repeated failed attempts', async () => {
    const user = await seedUser(db);

    for (let i = 0; i < 5; i += 1) {
      await server().post('/v1/auth/login').send({ email: user.email, password: 'wrong-password' });
    }

    // The 6th attempt uses the CORRECT password but the account is now locked.
    const response = await server().post('/v1/auth/login').send({ email: user.email, password: user.password });
    expect(response.status).toBe(401);

    const row = await db.user.findUniqueOrThrow({ where: { id: user.userId } });
    expect(row.lockedUntil).not.toBeNull();
    expect(row.lockedUntil!.getTime()).toBeGreaterThan(Date.now());
  });

});

describe('POST /v1/auth/refresh', () => {
  it('rotates the refresh token and rejects reuse of the old one', async () => {
    const user = await seedUser(db);
    const client = agent();

    const login = await client.post('/v1/auth/login').send({ email: user.email, password: user.password });
    expect(login.status).toBe(200);
    const originalRefreshCookie = (login.headers['set-cookie'] as string[]).find((c) => c.startsWith('gw_refresh='))!;

    const refreshed = await client.post('/v1/auth/refresh').send();
    expect(refreshed.status).toBe(200);
    const rotatedRefreshCookie = (refreshed.headers['set-cookie'] as string[]).find((c) => c.startsWith('gw_refresh='))!;
    expect(rotatedRefreshCookie).not.toBe(originalRefreshCookie);

    // Presenting the now-revoked original refresh token must fail.
    const reuse = await server().post('/v1/auth/refresh').set('Cookie', [originalRefreshCookie]).send();
    expect(reuse.status).toBe(401);
  });

  it('rejects a missing refresh cookie', async () => {
    const response = await server().post('/v1/auth/refresh').send();
    expect(response.status).toBe(401);
  });
});

describe('POST /v1/auth/logout', () => {
  it('revokes the session so a subsequent refresh fails', async () => {
    const user = await seedUser(db);
    const client = agent();

    await client.post('/v1/auth/login').send({ email: user.email, password: user.password });
    const logout = await client.post('/v1/auth/logout').send();
    expect(logout.status).toBe(200);

    const refresh = await client.post('/v1/auth/refresh').send();
    expect(refresh.status).toBe(401);
  });

  it('is idempotent when called with no session at all', async () => {
    const response = await server().post('/v1/auth/logout').send();
    expect(response.status).toBe(200);
  });
});

describe('GET /v1/auth/me', () => {
  it('returns the user and their merchant memberships', async () => {
    const merchant = await seedMerchant(db);
    const password = 'CorrectHorseBatteryStaple1!';
    const memberUser = await db.user.findFirstOrThrow({
      where: { memberships: { some: { merchantId: merchant.merchantId } } },
    });
    await db.user.update({ where: { id: memberUser.id }, data: { passwordHash: await hashPassword(password) } });

    const client = agent();
    const login = await client.post('/v1/auth/login').send({ email: memberUser.email, password });
    expect(login.status).toBe(200);

    const me = await client.get('/v1/auth/me').send();
    expect(me.status).toBe(200);
    expect(me.body.user.id).toBe(memberUser.id);
    expect(me.body.memberships).toEqual(
      expect.arrayContaining([expect.objectContaining({ merchant_id: merchant.merchantId, role: 'OWNER' })]),
    );
  });

  it('rejects a request with no session cookie', async () => {
    const response = await server().get('/v1/auth/me').send();
    expect(response.status).toBe(401);
  });

  it('rejects a tampered access cookie', async () => {
    const user = await seedUser(db);
    const client = agent();
    const login = await client.post('/v1/auth/login').send({ email: user.email, password: user.password });
    const accessCookie = (login.headers['set-cookie'] as string[]).find((c) => c.startsWith('gw_access='))!;
    const tampered = accessCookie.replace('gw_access=', 'gw_access=tampered.');

    const response = await server().get('/v1/auth/me').set('Cookie', [tampered]).send();
    expect(response.status).toBe(401);
  });
});
