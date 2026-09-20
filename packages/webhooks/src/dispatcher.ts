import type { DatabaseClient } from '@gateway/database';
import type { KeyProvider } from '@gateway/security';
import { decryptSecret, signWebhook } from '@gateway/security';
import { newId } from '@gateway/shared';
import { assertPublicWebhookUrl, type ResolveHostname, WebhookUrlError } from './ssrf-guard.js';
import { computeRetryDelayMs, isSuccessStatus } from './retry-policy.js';

/**
 * Delivers `webhook_events` to `webhook_endpoints` and records every attempt
 * in `webhook_deliveries` (SPEC sections 17, 18; ADR 0009).
 *
 * State machine, per (event, endpoint) pair:
 *
 *   enqueue          -> one row, attempt 1, PENDING, scheduledAt = now
 *   PENDING          -> IN_FLIGHT -> DELIVERED                       (2xx)
 *   PENDING          -> IN_FLIGHT -> FAILED (nextRetryAt set)        (more attempts left)
 *   PENDING          -> IN_FLIGHT -> EXHAUSTED                       (last attempt failed)
 *   FAILED, due      -> a NEW row is inserted for attempt+1, PENDING (never overwritten - the
 *                                                                     failed row stays as history)
 *   PENDING          -> ABANDONED                                    (endpoint disabled before send)
 *
 * The HTTP call is never made inside a database transaction: holding a
 * transaction open for up to `endpoint.timeoutMs` would tie up a pool
 * connection (and, worse, row locks) for as long as a slow or hanging
 * merchant endpoint takes to respond. Instead each attempt is bracketed by
 * two small writes (-> IN_FLIGHT, then -> final status), and
 * `recoverStaleInFlight` is the safety net for a worker that crashes between
 * them - see ADR 0009.
 */

export interface WebhookDispatcherOptions {
  keyProvider: KeyProvider;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  /** Endpoint auto-disables once this many consecutive delivery attempts have failed. */
  disableAfterConsecutiveFailures?: number;
  /** An IN_FLIGHT row untouched this long is assumed to be an orphan of a crashed worker. */
  staleInFlightMs?: number;
  /** Max rows fetched per phase per `runOnce`, to bound one poll's work. */
  batchSize?: number;
  blockPrivateNetworks?: boolean;
  resolveHostname?: ResolveHostname;
}

export interface WebhookDispatchSummary {
  enqueued: number;
  retriesPromoted: number;
  recoveredStale: number;
  delivered: number;
  failed: number;
  exhausted: number;
  abandoned: number;
}

const DEFAULT_DISABLE_AFTER_CONSECUTIVE_FAILURES = 50;
const DEFAULT_STALE_IN_FLIGHT_MS = 5 * 60 * 1000;
const DEFAULT_BATCH_SIZE = 100;
const MAX_RESPONSE_BODY_CHARS = 2000;

export class WebhookDispatcher {
  private readonly keyProvider: KeyProvider;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private readonly disableAfterConsecutiveFailures: number;
  private readonly staleInFlightMs: number;
  private readonly batchSize: number;
  private readonly blockPrivateNetworks: boolean;
  private readonly resolveHostname: ResolveHostname | undefined;

  constructor(
    private readonly db: DatabaseClient,
    options: WebhookDispatcherOptions,
  ) {
    this.keyProvider = options.keyProvider;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.disableAfterConsecutiveFailures = options.disableAfterConsecutiveFailures ?? DEFAULT_DISABLE_AFTER_CONSECUTIVE_FAILURES;
    this.staleInFlightMs = options.staleInFlightMs ?? DEFAULT_STALE_IN_FLIGHT_MS;
    this.batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
    this.blockPrivateNetworks = options.blockPrivateNetworks ?? true;
    this.resolveHostname = options.resolveHostname;
  }

  /** Deliveries abandoned in bulk (an endpoint disabling mid-run sweeps its OTHER queued rows) this `runOnce`. */
  private bulkAbandonedThisRun = 0;

  /** One full poll cycle: recover crashes, fan events out to deliveries, promote due retries, send what's due. */
  async runOnce(): Promise<WebhookDispatchSummary> {
    this.bulkAbandonedThisRun = 0;

    const recoveredStale = await this.recoverStaleInFlight();
    const enqueued = await this.enqueueNewDeliveries();
    const retriesPromoted = await this.promoteDueRetries();

    const outcome = { delivered: 0, failed: 0, exhausted: 0, abandoned: 0 };
    const due = await this.db.webhookDelivery.findMany({
      where: { status: 'PENDING', scheduledAt: { lte: this.now() } },
      orderBy: { createdAt: 'asc' },
      take: this.batchSize,
    });

    for (const delivery of due) {
      const result = await this.attemptDelivery(delivery.id);
      if (result) outcome[result] += 1;
    }
    outcome.abandoned += this.bulkAbandonedThisRun;

    return { enqueued, retriesPromoted, recoveredStale, ...outcome };
  }

  // ---------------------------------------------------------------------
  // Fan-out
  // ---------------------------------------------------------------------

  /**
   * Events with zero delivery rows so far get one PENDING attempt-1 row per
   * currently-enabled, subscribed endpoint of the event's merchant.
   *
   * The candidate query requires the merchant to have at least one enabled
   * endpoint RIGHT NOW, not just "zero deliveries so far": a merchant with no
   * endpoint configured produces events that can never be fanned out, and
   * without this filter they sit in the "unfanned" set forever, competing
   * with every real merchant's new events for this query's `take` slice on
   * every single poll. Past `batchSize` such permanently-unfannable events,
   * that starves out genuinely new work indefinitely - not a theoretical
   * risk, it reproduced in this package's own test database once enough
   * endpoint-less test fixtures had accumulated. A merchant's event still
   * gets backfilled the moment they configure their first endpoint, because
   * at that point it starts matching this same filter.
   *
   * KNOWN LIMITATION: this only recognises an event as "already fanned out" if
   * it has at least one delivery row. A merchant with an endpoint added AFTER
   * one of their events already reached a DIFFERENT endpoint will not get
   * that event backfilled to the new one. Acceptable: this matches how most
   * webhook systems behave (new endpoints see new events), see ADR 0009.
   */
  private async enqueueNewDeliveries(): Promise<number> {
    const unfannedEvents = await this.db.webhookEvent.findMany({
      where: { deliveries: { none: {} }, merchant: { webhookEndpoints: { some: { enabled: true } } } },
      orderBy: { createdAt: 'asc' },
      take: this.batchSize,
    });
    if (unfannedEvents.length === 0) return 0;

    let created = 0;
    for (const event of unfannedEvents) {
      const endpoints = await this.db.webhookEndpoint.findMany({
        where: { merchantId: event.merchantId, enabled: true },
      });

      for (const endpoint of endpoints) {
        if (endpoint.eventTypes.length > 0 && !endpoint.eventTypes.includes(event.type)) continue;

        const now = this.now();
        await this.db.webhookDelivery.upsert({
          where: { webhookEventId_endpointId_attempt: { webhookEventId: event.id, endpointId: endpoint.id, attempt: 1 } },
          update: {},
          create: {
            id: newId('webhookDelivery'),
            webhookEventId: event.id,
            endpointId: endpoint.id,
            url: endpoint.url,
            attempt: 1,
            status: 'PENDING',
            signatureTimestamp: now,
            scheduledAt: now,
          },
        });
        created += 1;
      }
    }
    return created;
  }

  /** FAILED rows whose retry is due get a new attempt+1 row; the FAILED row itself is left untouched as history. */
  private async promoteDueRetries(): Promise<number> {
    const due = await this.db.webhookDelivery.findMany({
      where: { status: 'FAILED', nextRetryAt: { lte: this.now() } },
      orderBy: { nextRetryAt: 'asc' },
      take: this.batchSize,
    });

    let promoted = 0;
    for (const previous of due) {
      const endpoint = await this.db.webhookEndpoint.findUnique({ where: { id: previous.endpointId } });
      const now = this.now();

      if (!endpoint || !endpoint.enabled) {
        // No further attempt will ever be made for this chain - say so explicitly
        // instead of leaving a FAILED row with a nextRetryAt that will never fire again.
        await this.db.webhookDelivery.update({ where: { id: previous.id }, data: { status: 'ABANDONED', nextRetryAt: null } });
        continue;
      }

      const nextAttempt = previous.attempt + 1;
      await this.db.webhookDelivery.upsert({
        where: { webhookEventId_endpointId_attempt: { webhookEventId: previous.webhookEventId, endpointId: previous.endpointId, attempt: nextAttempt } },
        update: {},
        create: {
          id: newId('webhookDelivery'),
          webhookEventId: previous.webhookEventId,
          endpointId: previous.endpointId,
          url: endpoint.url,
          attempt: nextAttempt,
          status: 'PENDING',
          signatureTimestamp: now,
          scheduledAt: now,
        },
      });
      promoted += 1;
    }
    return promoted;
  }

  /** A row stuck IN_FLIGHT past `staleInFlightMs` means the worker that owned it crashed mid-attempt. */
  private async recoverStaleInFlight(): Promise<number> {
    const cutoff = new Date(this.now().getTime() - this.staleInFlightMs);
    const stale = await this.db.webhookDelivery.findMany({
      where: { status: 'IN_FLIGHT', updatedAt: { lt: cutoff } },
      take: this.batchSize,
    });

    for (const delivery of stale) {
      await this.finalizeFailure(delivery.id, delivery.attempt, delivery.endpointId, {
        httpStatus: null,
        errorMessage: 'recovered: worker crashed mid-delivery',
        responseTimeMs: null,
      });
    }
    return stale.length;
  }

  // ---------------------------------------------------------------------
  // Sending
  // ---------------------------------------------------------------------

  private async attemptDelivery(deliveryId: string): Promise<'delivered' | 'failed' | 'exhausted' | 'abandoned' | null> {
    const delivery = await this.db.webhookDelivery.findUnique({ where: { id: deliveryId } });
    if (!delivery || delivery.status !== 'PENDING') return null; // raced with another worker or already handled

    const endpoint = await this.db.webhookEndpoint.findUnique({ where: { id: delivery.endpointId } });
    if (!endpoint || !endpoint.enabled) {
      await this.db.webhookDelivery.update({ where: { id: delivery.id }, data: { status: 'ABANDONED' } });
      return 'abandoned';
    }

    const event = await this.db.webhookEvent.findUnique({ where: { id: delivery.webhookEventId } });
    if (!event) {
      await this.db.webhookDelivery.update({ where: { id: delivery.id }, data: { status: 'ABANDONED', errorMessage: 'webhook event no longer exists' } });
      return 'abandoned';
    }

    const claimed = await this.db.webhookDelivery.updateMany({ where: { id: delivery.id, status: 'PENDING' }, data: { status: 'IN_FLIGHT' } });
    if (claimed.count === 0) return null; // another worker claimed it first

    if (this.blockPrivateNetworks) {
      try {
        await assertPublicWebhookUrl(endpoint.url, { resolve: this.resolveHostname });
      } catch (error) {
        const message = error instanceof WebhookUrlError ? error.message : 'blocked webhook URL';
        return this.finalizeFailure(delivery.id, delivery.attempt, endpoint.id, { httpStatus: null, errorMessage: message, responseTimeMs: null });
      }
    }

    const secret = decryptSecret(endpoint.secretEncrypted, this.keyProvider);
    const rawBody = JSON.stringify(event.payload);
    const timestampSeconds = Math.floor(this.now().getTime() / 1000);
    const signed = signWebhook(secret, rawBody, timestampSeconds);

    await this.db.webhookDelivery.update({ where: { id: delivery.id }, data: { signatureTimestamp: new Date(timestampSeconds * 1000) } });

    const startedAt = Date.now();
    try {
      const response = await this.fetchImpl(endpoint.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-signature': signed.signature,
          'x-timestamp': String(signed.timestamp),
          'x-webhook-event-id': event.id,
          'x-webhook-delivery-id': delivery.id,
          'x-webhook-event-type': event.type,
        },
        body: rawBody,
        signal: AbortSignal.timeout(endpoint.timeoutMs),
      });
      const responseTimeMs = Date.now() - startedAt;
      const responseBody = (await response.text().catch(() => '')).slice(0, MAX_RESPONSE_BODY_CHARS);

      if (isSuccessStatus(response.status)) {
        await this.finalizeSuccess(delivery.id, endpoint.id, response.status, responseTimeMs, responseBody);
        return 'delivered';
      }

      return this.finalizeFailure(delivery.id, delivery.attempt, endpoint.id, {
        httpStatus: response.status,
        errorMessage: `endpoint responded ${response.status}`,
        responseTimeMs,
        responseBody,
      });
    } catch (error) {
      const responseTimeMs = Date.now() - startedAt;
      const message = error instanceof Error ? error.message : 'unknown delivery error';
      return this.finalizeFailure(delivery.id, delivery.attempt, endpoint.id, { httpStatus: null, errorMessage: message, responseTimeMs });
    }
  }

  private async finalizeSuccess(deliveryId: string, endpointId: string, httpStatus: number, responseTimeMs: number, responseBody: string): Promise<void> {
    await this.db.webhookDelivery.update({
      where: { id: deliveryId },
      data: { status: 'DELIVERED', httpStatus, responseTimeMs, responseBody, sentAt: this.now(), nextRetryAt: null },
    });
    await this.db.webhookEndpoint.update({ where: { id: endpointId }, data: { consecutiveFailures: 0 } });
  }

  private async finalizeFailure(
    deliveryId: string,
    attempt: number,
    endpointId: string,
    info: { httpStatus: number | null; errorMessage: string; responseTimeMs: number | null; responseBody?: string },
  ): Promise<'failed' | 'exhausted' | 'abandoned'> {
    const endpoint = await this.db.webhookEndpoint.update({
      where: { id: endpointId },
      data: { consecutiveFailures: { increment: 1 } },
    });

    const attemptsExhausted = attempt >= endpoint.maxAttempts;
    const shouldDisable = !attemptsExhausted && endpoint.consecutiveFailures >= this.disableAfterConsecutiveFailures;
    if (shouldDisable) {
      await this.db.webhookEndpoint.update({
        where: { id: endpointId },
        data: { enabled: false, disabledAt: this.now(), disabledReason: `${endpoint.consecutiveFailures} consecutive delivery failures` },
      });
      const abandoned = await this.db.webhookDelivery.updateMany({ where: { endpointId, status: 'PENDING' }, data: { status: 'ABANDONED' } });
      this.bulkAbandonedThisRun += abandoned.count;
    }

    // Ran out of its own retry budget -> EXHAUSTED. Stopped because the
    // ENDPOINT just got disabled, with budget left on this chain -> ABANDONED
    // (matches the enum's "endpoint disabled" meaning, not "retries used up").
    const status = attemptsExhausted ? 'EXHAUSTED' : shouldDisable ? 'ABANDONED' : 'FAILED';
    const willRetry = status === 'FAILED';
    await this.db.webhookDelivery.update({
      where: { id: deliveryId },
      data: {
        status,
        httpStatus: info.httpStatus,
        errorMessage: info.errorMessage,
        responseTimeMs: info.responseTimeMs,
        responseBody: info.responseBody ?? null,
        sentAt: this.now(),
        nextRetryAt: willRetry ? new Date(this.now().getTime() + computeRetryDelayMs(attempt)) : null,
      },
    });

    return willRetry ? 'failed' : status === 'EXHAUSTED' ? 'exhausted' : 'abandoned';
  }
}
