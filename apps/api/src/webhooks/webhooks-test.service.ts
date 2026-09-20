import { Inject, Injectable } from '@nestjs/common';
import { NotFoundError, newId } from '@gateway/shared';
import { EnvKeyProvider, decryptSecret, signWebhook } from '@gateway/security';
import { WebhookUrlError, assertPublicWebhookUrl, isSuccessStatus } from '@gateway/webhooks';
import type { DatabaseClient } from '@gateway/database';
import { PRISMA_CLIENT } from '../database/prisma.module.js';

export interface TestWebhookResult {
  delivered: boolean;
  http_status: number | null;
  response_time_ms: number;
  error: string | null;
}

/**
 * Sends one synthetic test event to a merchant's endpoint synchronously and
 * reports the outcome directly - deliberately NOT the same path as
 * `@gateway/webhooks`'s `WebhookDispatcher`, which polls a persisted
 * `webhook_deliveries` queue. This never writes a `WebhookDelivery` row or
 * enqueues anything; if that ever changes, the dashboard's "send test" button
 * stops being able to show an immediate result, which is the entire point of
 * this endpoint existing separately from the real delivery pipeline.
 *
 * `merchantId` is a plain string, not a `MerchantContext` - callable from both
 * the API-key-guarded `POST /v1/webhooks/test` and the JWT-guarded dashboard
 * "send test" action, which resolve it through different guards.
 */
@Injectable()
export class WebhooksTestService {
  private readonly keyProvider = new EnvKeyProvider();

  constructor(@Inject(PRISMA_CLIENT) private readonly db: DatabaseClient) {}

  async sendTestEvent(merchantId: string, endpointId: string): Promise<TestWebhookResult> {
    const endpoint = await this.db.webhookEndpoint.findFirst({ where: { id: endpointId, merchantId } });
    if (!endpoint) {
      throw new NotFoundError('webhook endpoint', endpointId);
    }

    try {
      await assertPublicWebhookUrl(endpoint.url);
    } catch (error) {
      const message = error instanceof WebhookUrlError ? error.message : 'refused: blocked webhook URL';
      return { delivered: false, http_status: null, response_time_ms: 0, error: message };
    }

    const secret = decryptSecret(endpoint.secretEncrypted, this.keyProvider);
    const eventId = newId('webhookEvent');
    const rawBody = JSON.stringify({
      id: eventId,
      type: 'webhook.test',
      occurred_at: new Date().toISOString(),
      data: { message: 'This is a test event from the crypto payment gateway dashboard.' },
    });
    const timestampSeconds = Math.floor(Date.now() / 1000);
    const signed = signWebhook(secret, rawBody, timestampSeconds);

    const startedAt = Date.now();
    try {
      const response = await fetch(endpoint.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-signature': signed.signature,
          'x-timestamp': String(signed.timestamp),
          'x-webhook-event-id': eventId,
          'x-webhook-delivery-id': newId('webhookDelivery'),
          'x-webhook-event-type': 'webhook.test',
        },
        body: rawBody,
        signal: AbortSignal.timeout(endpoint.timeoutMs),
      });
      const success = isSuccessStatus(response.status);
      return {
        delivered: success,
        http_status: response.status,
        response_time_ms: Date.now() - startedAt,
        error: success ? null : `endpoint responded ${response.status}`,
      };
    } catch (error) {
      return {
        delivered: false,
        http_status: null,
        response_time_ms: Date.now() - startedAt,
        error: error instanceof Error ? error.message : 'unknown delivery error',
      };
    }
  }
}
