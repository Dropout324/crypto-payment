import type autocannon from 'autocannon';
import type { LoadtestFixture } from '../fixture.js';

/**
 * `GET /v1/public/invoices/:id` - the hosted payment page's poll loop, called
 * by an unauthenticated customer browser every few seconds while an invoice
 * is pending. No Argon2, no JWT verification; rate-limited by IP under the
 * default `'api'` profile (`PublicInvoicesController`), so every autocannon
 * connection here shares one bucket, same as real customers behind one NAT.
 *
 * Cycles through the fixed pool of invoices `seed.ts` created via the real
 * create-invoice endpoint, so every response is a real read of real invoice
 * state, not a 404.
 */
export function build(fixture: LoadtestFixture): Partial<autocannon.Options> {
  if (fixture.pollInvoiceIds.length === 0) {
    throw new Error('fixture has no pollInvoiceIds - re-run pnpm loadtest:seed');
  }

  return {
    url: fixture.apiBaseUrl,
    method: 'GET',
    requests: fixture.pollInvoiceIds.map((id) => ({ path: `/v1/public/invoices/${id}` })),
  };
}
