import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createPrismaClient, type PrismaClient } from '@gateway/database';
import { EnvKeyProvider, encryptSecret, verifyWebhookSignature } from '@gateway/security';
import { newId } from '@gateway/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebhookDispatcher } from '../src/index.js';

/**
 * `dispatcher.test.ts` mocks `fetchImpl` entirely, which proves the
 * dispatcher's own state machine but never proves a webhook can actually be
 * received and verified over the wire. This file is the complement: a real
 * `node:http` server stands in for a merchant's endpoint, and the dispatcher
 * makes a genuine loopback HTTP call to it (real DB too, via
 * `createPrismaClient` against the dev Postgres instance - no mocks anywhere
 * in the path being exercised).
 *
 * `blockPrivateNetworks: false` is required to reach 127.0.0.1 at all -
 * `assertPublicWebhookUrl` (ssrf-guard.ts) refuses loopback/private addresses
 * unconditionally, by design, and that check runs before any resolver hook
 * could redirect it. That is the right production behaviour and exactly why
 * it has to be turned off here.
 *
 * With the SSRF guard off, nothing stops `runOnce()` from also picking up
 * *other* files' leftover fixtures in this shared dev database (e.g.
 * `dispatcher.test.ts`'s `https://merchant.example.com/webhooks` endpoint,
 * whose retry timers are computed off a frozen test clock and can look "due"
 * again by real wall-clock time). `guardedFetch` below is the safety net:
 * it performs a real fetch, but only to this file's own receiver URL, so a
 * stray row can fail loudly instead of causing a real request to a
 * third-party host.
 */

let db: PrismaClient;
const keyProvider = new EnvKeyProvider();

const RUN = Date.now().toString(16);
let counter = 0;
function suffix(): string {
  counter += 1;
  return `${RUN}-${counter}`;
}

async function createMerchant(): Promise<string> {
  const s = suffix();
  const userId = newId('user');
  await db.user.create({ data: { id: userId, email: `wh-live-${s}@test.local`, passwordHash: 'x', platformRole: 'USER' } });
  const merchantId = newId('merchant');
  await db.merchant.create({ data: { id: merchantId, name: `Live Merchant ${s}`, slug: `live-merchant-${s}` } });
  await db.merchantMember.create({ data: { id: newId('user'), merchantId, userId, role: 'OWNER' } });
  return merchantId;
}

async function createEndpoint(
  merchantId: string,
  url: string,
  overrides: Partial<{ maxAttempts: number; timeoutMs: number }> = {},
): Promise<{ id: string; secret: string }> {
  const secret = `whsec_${suffix()}`;
  const endpoint = await db.webhookEndpoint.create({
    data: {
      id: newId('webhookEndpoint'),
      merchantId,
      url,
      eventTypes: [],
      secretEncrypted: encryptSecret(secret, keyProvider),
      secretFingerprint: secret.slice(0, 8),
      enabled: true,
      maxAttempts: overrides.maxAttempts ?? 8,
      timeoutMs: overrides.timeoutMs ?? 5000,
    },
  });
  return { id: endpoint.id, secret };
}

async function createEvent(merchantId: string, type = 'payment.paid'): Promise<string> {
  const id = newId('webhookEvent');
  await db.webhookEvent.create({
    data: { id, merchantId, type, idempotencyKey: `${type}:${id}`, payload: { event: type, data: { invoice_id: `inv_${suffix()}` } } },
  });
  return id;
}

interface ReceivedRequest {
  headers: Record<string, string>;
  body: string;
}

/** A real HTTP server on loopback - the dispatcher's request to it is a genuine network round trip. */
function startReceiver(
  handle: (received: ReceivedRequest, req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server: Server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const headers = Object.fromEntries(
          Object.entries(req.headers).map(([key, value]) => [key, Array.isArray(value) ? value.join(',') : (value ?? '')]),
        );
        handle({ headers, body: Buffer.concat(chunks).toString('utf8') }, req, res);
      });
    });

    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}/webhook`,
        close: () => new Promise((res) => server.close(() => res())),
      });
    });
  });
}

/** Real fetch, but scoped to `allowedUrl` so a leftover fixture from another test file cannot reach a live third-party host once the SSRF guard is off. */
function guardedFetch(allowedUrl: string): typeof fetch {
  return (async (url: string | URL, init?: RequestInit) => {
    if (String(url) !== allowedUrl) {
      throw new Error(`live-http test guard: refusing a real request to unexpected URL ${String(url)}`);
    }
    return fetch(url, init);
  }) as typeof fetch;
}

beforeAll(async () => {
  db = createPrismaClient();
  await db.$connect();
});

afterAll(async () => {
  await db.$disconnect();
});

describe('WebhookDispatcher: live HTTP delivery', () => {
  it('delivers over a real loopback connection with a signature the receiver verifies itself', async () => {
    let received: ReceivedRequest | null = null;
    const receiver = await startReceiver((req, _reqRaw, res) => {
      received = req;
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
    });

    try {
      const merchantId = await createMerchant();
      const { id: endpointId, secret } = await createEndpoint(merchantId, receiver.url);
      const eventId = await createEvent(merchantId, 'payment.paid');

      const dispatcher = new WebhookDispatcher(db, {
        keyProvider,
        blockPrivateNetworks: false,
        fetchImpl: guardedFetch(receiver.url),
      });
      const summary = await dispatcher.runOnce();

      expect(summary.delivered).toBeGreaterThanOrEqual(1);

      const delivery = await db.webhookDelivery.findFirstOrThrow({ where: { webhookEventId: eventId, endpointId } });
      expect(delivery.status).toBe('DELIVERED');
      expect(delivery.httpStatus).toBe(200);

      expect(received).not.toBeNull();
      expect(received!.headers['x-webhook-event-id']).toBe(eventId);
      expect(received!.headers['content-type']).toBe('application/json');

      // The receiver verifies the signature exactly as a real merchant's
      // integration would: over the raw bytes it received, with its own copy
      // of the secret - nothing here is asserted from the sender's side.
      const verification = verifyWebhookSignature(secret, received!.body, received!.headers['x-signature']);
      expect(verification.valid).toBe(true);
      expect(JSON.parse(received!.body)).toMatchObject({ event: 'payment.paid' });
    } finally {
      await receiver.close();
    }
  });

  it('retries after a real failed response and succeeds on a real second attempt', async () => {
    let requestCount = 0;
    const receiver = await startReceiver((_req, _reqRaw, res) => {
      requestCount += 1;
      if (requestCount === 1) {
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end('server error');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
    });

    try {
      const merchantId = await createMerchant();
      const { id: endpointId } = await createEndpoint(merchantId, receiver.url, { maxAttempts: 2 });
      const eventId = await createEvent(merchantId, 'payment.underpaid');

      const now = new Date();
      const dispatcher = new WebhookDispatcher(db, {
        keyProvider,
        blockPrivateNetworks: false,
        fetchImpl: guardedFetch(receiver.url),
        now: () => now,
      });
      await dispatcher.runOnce();

      const firstAttempt = await db.webhookDelivery.findFirstOrThrow({ where: { webhookEventId: eventId, endpointId, attempt: 1 } });
      expect(firstAttempt.status).toBe('FAILED');
      expect(firstAttempt.httpStatus).toBe(500);
      expect(requestCount).toBe(1);

      const later = new Date(firstAttempt.nextRetryAt!.getTime() + 1);
      const dispatcherLater = new WebhookDispatcher(db, {
        keyProvider,
        blockPrivateNetworks: false,
        fetchImpl: guardedFetch(receiver.url),
        now: () => later,
      });
      await dispatcherLater.runOnce();

      expect(requestCount).toBe(2);
      const secondAttempt = await db.webhookDelivery.findFirstOrThrow({ where: { webhookEventId: eventId, endpointId, attempt: 2 } });
      expect(secondAttempt.status).toBe('DELIVERED');
      expect(secondAttempt.httpStatus).toBe(200);
    } finally {
      await receiver.close();
    }
  });

  it('aborts a real connection that outlives the endpoint timeout', async () => {
    const pendingTimers = new Set<NodeJS.Timeout>();
    const receiver = await startReceiver((_req, reqRaw, res) => {
      // Never actually respond within the endpoint's timeout; clear the timer
      // if the client aborts first so the process has nothing left pending.
      const timer = setTimeout(() => {
        pendingTimers.delete(timer);
        if (!res.writableEnded) res.end('too late');
      }, 2000);
      pendingTimers.add(timer);
      reqRaw.on('close', () => {
        clearTimeout(timer);
        pendingTimers.delete(timer);
      });
    });

    try {
      const merchantId = await createMerchant();
      const { id: endpointId } = await createEndpoint(merchantId, receiver.url, { timeoutMs: 200 });
      const eventId = await createEvent(merchantId, 'payment.confirming');

      const dispatcher = new WebhookDispatcher(db, {
        keyProvider,
        blockPrivateNetworks: false,
        fetchImpl: guardedFetch(receiver.url),
      });
      const summary = await dispatcher.runOnce();

      expect(summary.delivered).toBe(0);
      const delivery = await db.webhookDelivery.findFirstOrThrow({ where: { webhookEventId: eventId, endpointId, attempt: 1 } });
      expect(delivery.status).toBe('FAILED');
      expect(delivery.httpStatus).toBeNull();
      expect(delivery.errorMessage).toBeTruthy();
    } finally {
      for (const timer of pendingTimers) clearTimeout(timer);
      await receiver.close();
    }
  });
});
