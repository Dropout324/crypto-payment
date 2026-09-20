import { randomUUID } from 'node:crypto';
import type autocannon from 'autocannon';
import type { LoadtestFixture } from '../fixture.js';

/**
 * `POST /v1/payment-invoices` - the one write endpoint on the write-heavy
 * path: `ApiKeyGuard` runs an Argon2id verify (SPEC section 15) on every
 * call, then `InvoicesService` reserves a deposit address with `SELECT ...
 * FOR UPDATE SKIP LOCKED` (ADR-adjacent note in `invoices.service.ts`) so
 * concurrent creations do not queue behind each other or double-assign an
 * address. This is the scenario most likely to be bottlenecked by CPU
 * (Argon2) rather than by the database.
 *
 * Every request needs a distinct `order_id` (UNIQUE per merchant) and a
 * distinct `Idempotency-Key` - reusing either would make the second request
 * onward a no-op idempotent replay instead of a real address-pool draw, which
 * would silently invalidate the throughput number. `setupRequest` mutates
 * both per call.
 *
 * Each successful call permanently retires one seeded address (never
 * reused - SPEC section 8), so a run's `amount`/`duration` × `connections`
 * must stay under `fixture.seededAddressCount` or later requests will start
 * failing with 422 ADDRESS_POOL_EXHAUSTED - itself a real, useful signal, not
 * a bug in the harness.
 */
export function build(fixture: LoadtestFixture): Partial<autocannon.Options> {
  return {
    url: fixture.apiBaseUrl,
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${fixture.apiKeyPlaintext}`,
    },
    requests: [
      {
        path: '/v1/payment-invoices',
        setupRequest: (request) => {
          const uniqueId = randomUUID();
          request.headers = { ...request.headers, 'idempotency-key': uniqueId };
          request.body = JSON.stringify({
            order_id: `loadtest-${uniqueId}`,
            amount: '10.00',
            currency: fixture.currency,
            asset: fixture.asset,
            network: fixture.network,
          });
          return request;
        },
      },
    ],
  };
}
