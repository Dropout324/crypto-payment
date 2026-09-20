import { createApp } from '../../src/bootstrap.js';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { DatabaseClient } from '@gateway/database';
import { createPrismaClient } from '@gateway/database';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedUser } from '../support/seed-user.js';

/**
 * `create-test-app.ts` (used by every other e2e file) boots `AppModule`
 * directly and only carries over `AppExceptionFilter` + `ValidationPipe` -
 * it never registers `@fastify/helmet`, `@fastify/cors`, or the
 * bodyLimit-enforcing content-type parser that `bootstrap.ts#createApp()`
 * adds for the real server (see that file's own comment on why: Nest
 * registers a conflicting default JSON parser during `listen()`/`init()`).
 * That means no e2e test anywhere has ever asserted the transport-level
 * hardening actually applies. This file boots the real `createApp()`
 * instead, specifically to close that gap.
 */

let app: NestFastifyApplication;
let db: DatabaseClient;

beforeAll(async () => {
  app = await createApp();
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  db = createPrismaClient();
  await db.$connect();
});

afterAll(async () => {
  await app.close();
  await db.$disconnect();
});

function server() {
  return request(app.getHttpServer());
}

describe('transport-level hardening (helmet, CORS, body limit)', () => {
  it('sets baseline helmet security headers and never sends X-Powered-By', async () => {
    const response = await server().get('/v1/health');

    expect(response.status).toBe(200);
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-dns-prefetch-control']).toBeDefined();
    expect(response.headers['x-powered-by']).toBeUndefined();
  });

  it('reflects the configured CORS origin with credentials allowed', async () => {
    const response = await server().get('/v1/health').set('Origin', 'http://localhost:3000');

    expect(response.headers['access-control-allow-origin']).toBe('http://localhost:3000');
    expect(response.headers['access-control-allow-credentials']).toBe('true');
  });

  it('does not reflect a disallowed CORS origin', async () => {
    const response = await server().get('/v1/health').set('Origin', 'https://evil.example.com');

    expect(response.headers['access-control-allow-origin']).not.toBe('https://evil.example.com');
  });

  /**
   * `@fastify/cors@11` defaults `methods` to `'GET,HEAD,POST'` - PATCH and
   * DELETE are not on that list unless named explicitly. That silently
   * broke every browser-based PATCH/DELETE dashboard action (Phase 18:
   * toggling a webhook endpoint, changing a team member's role, removing a
   * team member) - the browser's own preflight rejected the request before
   * it ever reached a route, with no server-side log and no application
   * error to point at. Caught only by actually driving the browser against
   * a real server, not by any unit test or code review.
   */
  it.each(['PATCH', 'DELETE'] as const)('allows a %s preflight request, not just GET/HEAD/POST', async (method) => {
    const response = await server()
      .options('/v1/merchant/me/webhook-endpoints/whe_test')
      .set('Origin', 'http://localhost:3000')
      .set('Access-Control-Request-Method', method)
      .set('Access-Control-Request-Headers', 'content-type,x-merchant-id');

    expect(response.status).toBe(204);
    expect(response.headers['access-control-allow-methods']).toContain(method);
  });

  it('rejects a JSON body over the configured 256KB limit instead of buffering it unbounded', async () => {
    const oversized = { email: 'a@example.test', password: 'x'.repeat(280 * 1024) };

    const response = await server().post('/v1/auth/login').send(oversized);

    expect(response.status).toBe(413);
  });

  it('sets HttpOnly and SameSite=Lax on both session cookies (CSRF/XSS-exfiltration defence)', async () => {
    const user = await seedUser(db);
    const response = await server().post('/v1/auth/login').send({ email: user.email, password: user.password });
    expect(response.status).toBe(200);

    const cookies = response.headers['set-cookie'] as unknown as string[];
    const access = cookies.find((c) => c.startsWith('gw_access='))!;
    const refresh = cookies.find((c) => c.startsWith('gw_refresh='))!;

    for (const cookie of [access, refresh]) {
      expect(cookie).toMatch(/HttpOnly/i);
      expect(cookie).toMatch(/SameSite=Lax/i);
    }
  });
});
