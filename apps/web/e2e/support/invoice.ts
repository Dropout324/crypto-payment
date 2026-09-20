import type { Page } from '@playwright/test';
import { randomBytes, randomUUID } from 'node:crypto';
import { API_URL } from './constants';

/**
 * A deposit address is single-use (one invoice ever draws it from the pool,
 * see apps/api/src/invoices/invoices.service.ts), so each test run needs its
 * own address rather than a fixed constant, or the pool would be exhausted
 * after the first run. All-lowercase hex is a structurally valid,
 * un-checksummed EVM address (packages/blockchain/src/address/evm.ts) -
 * never used for a real transfer.
 */
function randomTestAddress(): string {
  return `0x${randomBytes(20).toString('hex')}`;
}

/**
 * Creates a fresh API key (via the caller's browser session) and, with it,
 * registers a deposit address and opens one invoice - purely through public
 * API endpoints, so this stays black-box even though it bypasses the UI for
 * setup. `page.request` shares the browser context's cookie jar, so this
 * must be called after `login()` has put a session cookie in `page`.
 *
 * Requires a real exchange-rate provider reachable from the test machine
 * (ADR 0005 - no fake mode outside unit tests); callers should treat a
 * thrown error here as "skip, infra unavailable" rather than a test failure.
 */
export async function createTestInvoice(page: Page): Promise<{ invoiceId: string }> {
  // Session-authenticated merchant endpoints need an explicit X-Merchant-Id
  // (see apps/web/src/lib/merchant.ts - it isn't baked into the session JWT),
  // which the browser normally gets from its own /v1/auth/me call.
  const meResponse = await page.request.get(`${API_URL}/v1/auth/me`);
  if (!meResponse.ok()) {
    throw new Error(`failed to resolve session: ${meResponse.status()} ${await meResponse.text()}`);
  }
  const me = (await meResponse.json()) as { memberships: Array<{ merchant_id: string }> };
  const merchantId = me.memberships[0]?.merchant_id;
  if (!merchantId) throw new Error('session has no merchant membership');
  const merchantHeaders = { 'x-merchant-id': merchantId };

  const keyResponse = await page.request.post(`${API_URL}/v1/merchant/me/api-keys`, {
    headers: merchantHeaders,
    data: { name: `playwright-${randomUUID()}`, livemode: false, scopes: ['invoices:write'] },
  });
  if (!keyResponse.ok()) {
    throw new Error(`failed to create API key: ${keyResponse.status()} ${await keyResponse.text()}`);
  }
  const { plaintext } = (await keyResponse.json()) as { plaintext: string };
  const authHeaders = { Authorization: `Bearer ${plaintext}` };

  const addressResponse = await page.request.post(`${API_URL}/v1/merchant/addresses`, {
    headers: authHeaders,
    data: { network: 'ETHEREUM_SEPOLIA', asset: 'ETH', address: randomTestAddress(), label: 'playwright e2e' },
  });
  if (!addressResponse.ok()) {
    throw new Error(`failed to register address: ${addressResponse.status()} ${await addressResponse.text()}`);
  }

  const invoiceResponse = await page.request.post(`${API_URL}/v1/payment-invoices`, {
    headers: { ...authHeaders, 'Idempotency-Key': randomUUID() },
    data: {
      order_id: `playwright-${randomUUID()}`,
      amount: '25.00',
      currency: 'USD',
      asset: 'ETH',
      network: 'ETHEREUM_SEPOLIA',
    },
  });
  if (!invoiceResponse.ok()) {
    throw new Error(`failed to create invoice: ${invoiceResponse.status()} ${await invoiceResponse.text()}`);
  }
  const invoice = (await invoiceResponse.json()) as { id: string };
  return { invoiceId: invoice.id };
}
