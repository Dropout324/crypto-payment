import type { DatabaseClient } from '@gateway/database';
import { createPrismaClient } from '@gateway/database';
import { signJwt } from '@gateway/security';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../support/create-test-app.js';
import { loadConfig } from '../../src/config/env.js';
import { ACCESS_TOKEN_COOKIE } from '../../src/auth/cookies.js';
import { seedUser } from '../support/seed-user.js';

/**
 * `JwtAuthGuard` trusts the `gw_access` cookie's claims directly - no DB
 * lookup per request (see the guard's own doc comment). That statelessness
 * is only safe if forging or mutating the token is actually impossible. This
 * file exercises the forgery attempts a stateless-JWT design must resist:
 * an unsigned ("none" algorithm) token, a token signed with a guessed/wrong
 * secret, a payload edited after signing (privilege escalation via a
 * hand-edited `platform_role` claim), and a naturally expired token.
 */

let testApp: TestApp;
let db: DatabaseClient;
const config = loadConfig();

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

function withAccessCookie(token: string) {
  return server().get('/v1/auth/me').set('Cookie', [`${ACCESS_TOKEN_COOKIE}=${token}`]);
}

function base64url(input: string): string {
  return Buffer.from(input, 'utf8').toString('base64url');
}

describe('access-token forgery resistance', () => {
  it('rejects a classic "alg: none" token with an empty signature', async () => {
    const header = base64url(JSON.stringify({ alg: 'none', typ: 'JWT' }));
    const payload = base64url(
      JSON.stringify({
        sub: 'usr_admin',
        email: 'admin@example.test',
        platform_role: 'ADMIN',
        iss: config.jwtIssuer,
        aud: config.jwtAudience,
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
      }),
    );
    const forged = `${header}.${payload}.`;

    const response = await withAccessCookie(forged).send();
    expect(response.status).toBe(401);
  });

  it('rejects a token signed with a guessed secret instead of the real one', async () => {
    const forged = signJwt(
      { sub: 'usr_admin', email: 'admin@example.test', platform_role: 'ADMIN' },
      'a-completely-wrong-secret-value-0123456789',
      { expiresInSeconds: 3600, issuer: config.jwtIssuer, audience: config.jwtAudience },
    );

    const response = await withAccessCookie(forged).send();
    expect(response.status).toBe(401);
  });

  it('rejects a legitimately-issued token whose payload was edited to escalate platform_role', async () => {
    const user = await seedUser(db); // platform_role: USER
    const client = request.agent(testApp.app.getHttpServer());
    const login = await client.post('/v1/auth/login').send({ email: user.email, password: user.password });
    const accessCookie = (login.headers['set-cookie'] as string[]).find((c) => c.startsWith(`${ACCESS_TOKEN_COOKIE}=`))!;
    const rawToken = decodeURIComponent(accessCookie.split(';')[0]!.split('=').slice(1).join('='));
    const [headerPart, payloadPart, signaturePart] = rawToken.split('.');

    const claims = JSON.parse(Buffer.from(payloadPart!, 'base64url').toString('utf8'));
    expect(claims.platform_role).toBe('USER');
    claims.platform_role = 'ADMIN';
    const tamperedPayload = base64url(JSON.stringify(claims));
    const tampered = `${headerPart}.${tamperedPayload}.${signaturePart}`;

    const response = await withAccessCookie(tampered).send();
    expect(response.status).toBe(401);
  });

  it('rejects an expired token even though its signature is otherwise valid', async () => {
    const expired = signJwt(
      { sub: 'usr_whatever', email: 'x@example.test', platform_role: 'USER' },
      config.jwtAccessSecret,
      { expiresInSeconds: -10, issuer: config.jwtIssuer, audience: config.jwtAudience },
    );

    const response = await withAccessCookie(expired).send();
    expect(response.status).toBe(401);
  });

  it('rejects a token issued for a different audience or issuer', async () => {
    const wrongAudience = signJwt(
      { sub: 'usr_whatever', email: 'x@example.test', platform_role: 'USER' },
      config.jwtAccessSecret,
      { expiresInSeconds: 3600, issuer: config.jwtIssuer, audience: 'some-other-app' },
    );
    const wrongIssuer = signJwt(
      { sub: 'usr_whatever', email: 'x@example.test', platform_role: 'USER' },
      config.jwtAccessSecret,
      { expiresInSeconds: 3600, issuer: 'some-other-issuer', audience: config.jwtAudience },
    );

    expect((await withAccessCookie(wrongAudience).send()).status).toBe(401);
    expect((await withAccessCookie(wrongIssuer).send()).status).toBe(401);
  });

  it('a still-valid access token keeps working for a few minutes after the account is suspended (documented limitation: stateless short-lived JWT, no per-request DB check)', async () => {
    const user = await seedUser(db);
    const client = request.agent(testApp.app.getHttpServer());
    await client.post('/v1/auth/login').send({ email: user.email, password: user.password });

    await db.user.update({ where: { id: user.userId }, data: { status: 'SUSPENDED' } });

    const response = await client.get('/v1/auth/me').send();
    // Documents current behaviour rather than asserting a security property:
    // dashboard access is not revoked mid-token-lifetime on suspension. The
    // exposure window is bounded by JWT_ACCESS_TTL_SECONDS (900s / 15min by
    // default) and refresh is blocked (AuthService.refresh checks
    // user.status), so it cannot be extended - but immediate revocation on
    // suspension would require moving JwtAuthGuard back to a DB lookup.
    expect(response.status).toBe(200);

    const refresh = await client.post('/v1/auth/refresh').send();
    expect(refresh.status).toBe(401);
  });
});
