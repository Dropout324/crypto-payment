import { createPrismaClient, type PrismaClient } from '@gateway/database';
import { EnvKeyProvider, encryptSecret, verifyWebhookSignature } from '@gateway/security';
import { newId } from '@gateway/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { WebhookDispatcher } from '../src/index.js';

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
  await db.user.create({ data: { id: userId, email: `wh-${s}@test.local`, passwordHash: 'x', platformRole: 'USER' } });
  const merchantId = newId('merchant');
  await db.merchant.create({ data: { id: merchantId, name: `Merchant ${s}`, slug: `merchant-${s}` } });
  await db.merchantMember.create({ data: { id: newId('user'), merchantId, userId, role: 'OWNER' } });
  return merchantId;
}

async function createEndpoint(
  merchantId: string,
  overrides: Partial<{ url: string; secret: string; enabled: boolean; maxAttempts: number; timeoutMs: number; eventTypes: string[]; consecutiveFailures: number }> = {},
): Promise<{ id: string; secret: string }> {
  const secret = overrides.secret ?? `whsec_${suffix()}`;
  const endpoint = await db.webhookEndpoint.create({
    data: {
      id: newId('webhookEndpoint'),
      merchantId,
      url: overrides.url ?? 'https://merchant.example.com/webhooks',
      eventTypes: overrides.eventTypes ?? [],
      secretEncrypted: encryptSecret(secret, keyProvider),
      secretFingerprint: secret.slice(0, 8),
      enabled: overrides.enabled ?? true,
      maxAttempts: overrides.maxAttempts ?? 8,
      timeoutMs: overrides.timeoutMs ?? 5000,
      consecutiveFailures: overrides.consecutiveFailures ?? 0,
    },
  });
  return { id: endpoint.id, secret };
}

async function createEvent(merchantId: string, type = 'payment.paid'): Promise<string> {
  const id = newId('webhookEvent');
  await db.webhookEvent.create({
    data: {
      id,
      merchantId,
      type,
      idempotencyKey: `${type}:${id}`,
      payload: { event: type, data: { invoice_id: 'inv_test' } },
    },
  });
  return id;
}

// Every resolved hostname in these tests is treated as public - the SSRF
// guard itself is covered in ssrf-guard.test.ts and would otherwise reject
// the fake "merchant.example.com" host these tests POST to.
const resolvePublic = vi.fn().mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);

beforeAll(async () => {
  db = createPrismaClient();
  await db.$connect();
});

afterAll(async () => {
  await db.$disconnect();
});

describe('WebhookDispatcher', () => {
  it('fans a new event out to every enabled, subscribed endpoint and delivers on 2xx', async () => {
    const merchantId = await createMerchant();
    const { id: endpointId, secret } = await createEndpoint(merchantId);
    const eventId = await createEvent(merchantId);

    let capturedBody = '';
    let capturedHeaders: Record<string, string> = {};
    const fetchImpl = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      capturedBody = String(init?.body ?? '');
      capturedHeaders = Object.fromEntries(new Headers(init?.headers).entries());
      return new Response('ok', { status: 200 });
    });

    const dispatcher = new WebhookDispatcher(db, { keyProvider, fetchImpl: fetchImpl as unknown as typeof fetch, resolveHostname: resolvePublic });
    const summary = await dispatcher.runOnce();

    // These counts are process-wide, not scoped to this test's merchant (a real
    // dispatcher polls the whole table) - the dev database is shared across
    // test files/runs, so assert "at least" here and verify correctness on
    // this test's own row directly below.
    expect(summary.enqueued).toBeGreaterThanOrEqual(1);
    expect(summary.delivered).toBeGreaterThanOrEqual(1);

    const delivery = await db.webhookDelivery.findFirstOrThrow({ where: { webhookEventId: eventId, endpointId } });
    expect(delivery.status).toBe('DELIVERED');
    expect(delivery.attempt).toBe(1);
    expect(delivery.httpStatus).toBe(200);

    const verification = verifyWebhookSignature(secret, capturedBody, capturedHeaders['x-signature'] ?? '');
    expect(verification.valid).toBe(true);
  });

  it('does not deliver to a disabled endpoint, and does not enqueue for one filtered out by event type', async () => {
    const merchantId = await createMerchant();
    await createEndpoint(merchantId, { enabled: false });
    await createEndpoint(merchantId, { eventTypes: ['payment.cancelled'] });
    await createEvent(merchantId, 'payment.paid');

    const fetchImpl = vi.fn();
    const dispatcher = new WebhookDispatcher(db, { keyProvider, fetchImpl: fetchImpl as unknown as typeof fetch, resolveHostname: resolvePublic });
    const summary = await dispatcher.runOnce();

    expect(summary.enqueued).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('schedules a retry with backoff on failure, then exhausts after the last attempt', async () => {
    const merchantId = await createMerchant();
    const { id: endpointId } = await createEndpoint(merchantId, { maxAttempts: 2 });
    const eventId = await createEvent(merchantId);

    const fetchImpl = vi.fn(async () => new Response('error', { status: 500 }));
    const now = new Date('2026-01-01T00:00:00.000Z');
    const dispatcher = new WebhookDispatcher(db, { keyProvider, fetchImpl: fetchImpl as unknown as typeof fetch, resolveHostname: resolvePublic, now: () => now });

    const first = await dispatcher.runOnce();
    expect(first.delivered).toBe(0); // fetchImpl always 500s in this test, so nothing process-wide can succeed
    expect(first.failed).toBeGreaterThanOrEqual(1);

    const firstAttempt = await db.webhookDelivery.findFirstOrThrow({ where: { webhookEventId: eventId, endpointId, attempt: 1 } });
    expect(firstAttempt.status).toBe('FAILED');
    expect(firstAttempt.nextRetryAt).not.toBeNull();
    expect(firstAttempt.nextRetryAt!.getTime()).toBeGreaterThan(now.getTime());

    // Advance the clock past the scheduled retry and run again.
    const later = new Date(firstAttempt.nextRetryAt!.getTime() + 1);
    const dispatcherLater = new WebhookDispatcher(db, { keyProvider, fetchImpl: fetchImpl as unknown as typeof fetch, resolveHostname: resolvePublic, now: () => later });
    const second = await dispatcherLater.runOnce();

    expect(second.retriesPromoted).toBeGreaterThanOrEqual(1);
    expect(second.exhausted).toBeGreaterThanOrEqual(1);

    const secondAttempt = await db.webhookDelivery.findFirstOrThrow({ where: { webhookEventId: eventId, endpointId, attempt: 2 } });
    expect(secondAttempt.status).toBe('EXHAUSTED');
    expect(secondAttempt.nextRetryAt).toBeNull();

    // The first attempt's row is untouched history, not overwritten.
    const firstAttemptAfter = await db.webhookDelivery.findUniqueOrThrow({ where: { id: firstAttempt.id } });
    expect(firstAttemptAfter.status).toBe('FAILED');
  });

  it('auto-disables an endpoint after too many consecutive failures and abandons its queued deliveries', async () => {
    const merchantId = await createMerchant();
    const { id: endpointId } = await createEndpoint(merchantId, { maxAttempts: 8 });
    await createEvent(merchantId);
    const pendingEventId = await createEvent(merchantId, 'payment.underpaid');

    const fetchImpl = vi.fn(async () => new Response('error', { status: 500 }));
    const dispatcher = new WebhookDispatcher(db, {
      keyProvider,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      resolveHostname: resolvePublic,
      disableAfterConsecutiveFailures: 1,
    });

    const summary = await dispatcher.runOnce();
    // The first failing delivery pushes consecutiveFailures to 1, which meets
    // the threshold - the endpoint disables, and the OTHER event fanned out to
    // it in the same pass is abandoned rather than sent.
    expect(summary.abandoned).toBeGreaterThanOrEqual(1);

    const endpoint = await db.webhookEndpoint.findUniqueOrThrow({ where: { id: endpointId } });
    expect(endpoint.enabled).toBe(false);

    const otherDelivery = await db.webhookDelivery.findFirstOrThrow({ where: { webhookEventId: pendingEventId, endpointId } });
    expect(otherDelivery.status).toBe('ABANDONED');
  });

  it('recovers a delivery stuck IN_FLIGHT by a crashed worker and retries it', async () => {
    const merchantId = await createMerchant();
    // maxAttempts: 1 so the recovered attempt lands straight on EXHAUSTED - a
    // recovered-but-still-retryable row would schedule a real future
    // nextRetryAt that outlives this test and gets swept up (and re-sent
    // through some LATER test's fetch mock) by a subsequent, unrelated test
    // run's promoteDueRetries, since retries are intentionally global/unscoped.
    const { id: endpointId } = await createEndpoint(merchantId, { maxAttempts: 1 });
    const eventId = await createEvent(merchantId);

    const stuck = await db.webhookDelivery.create({
      data: {
        id: newId('webhookDelivery'),
        webhookEventId: eventId,
        endpointId,
        url: 'https://merchant.example.com/webhooks',
        attempt: 1,
        status: 'IN_FLIGHT',
        signatureTimestamp: new Date(Date.now() - 10 * 60 * 1000),
        scheduledAt: new Date(Date.now() - 10 * 60 * 1000),
      },
    });
    // Push updatedAt into the past so it looks stale to the recovery check.
    await db.$executeRaw`UPDATE webhook_deliveries SET updated_at = NOW() - INTERVAL '10 minutes' WHERE id = ${stuck.id}`;

    const fetchImpl = vi.fn(async () => new Response('ok', { status: 200 }));
    const dispatcher = new WebhookDispatcher(db, { keyProvider, fetchImpl: fetchImpl as unknown as typeof fetch, resolveHostname: resolvePublic, staleInFlightMs: 60_000 });
    const summary = await dispatcher.runOnce();

    expect(summary.recoveredStale).toBeGreaterThanOrEqual(1);
    const recovered = await db.webhookDelivery.findUniqueOrThrow({ where: { id: stuck.id } });
    expect(recovered.status).toBe('EXHAUSTED');
    expect(recovered.nextRetryAt).toBeNull();
  });
});
