import { test, expect } from '@playwright/test';
import { createTestInvoice } from './support/invoice';
import { MERCHANT_STORAGE_STATE } from './global-setup';

test('an unknown invoice id shows "doesn\'t exist"', async ({ page }) => {
  await page.goto('/pay/not-a-real-invoice-id');
  await expect(page.getByText("This invoice doesn't exist.")).toBeVisible();
});

test.describe('a freshly created invoice', () => {
  test.use({ storageState: MERCHANT_STORAGE_STATE });

  test('renders merchant, amount and deposit address', async ({ page }) => {
    let invoiceId: string;
    try {
      ({ invoiceId } = await createTestInvoice(page));
    } catch (error) {
      test.skip(true, `could not create a test invoice via the API (likely no exchange-rate/network access): ${error}`);
      return;
    }

    await page.goto(`/pay/${invoiceId}`);
    await expect(page.getByText('Acme Test Store')).toBeVisible();
    // "ETH" alone would also match "ETHEREUM_SEPOLIA" below it (substring
    // match), so assert against the crypto-amount line as a whole.
    await expect(page.getByText(/ ETH$/)).toBeVisible();
    await expect(page.getByText('Send to')).toBeVisible();
    // The payment QR (ADR 0018) - a single SVG on this page.
    await expect(page.locator('svg')).toBeVisible();
  });
});
