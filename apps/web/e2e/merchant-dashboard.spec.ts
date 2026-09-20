import { test, expect } from '@playwright/test';
import { MERCHANT_STORAGE_STATE } from './global-setup';

test.use({ storageState: MERCHANT_STORAGE_STATE });

const PAGES: Array<{ href: string; navLabel: string; heading: string }> = [
  { href: '/dashboard', navLabel: 'Overview', heading: 'Overview' },
  { href: '/dashboard/invoices', navLabel: 'Invoices', heading: 'Invoices' },
  { href: '/dashboard/transactions', navLabel: 'Transactions', heading: 'Transactions' },
  { href: '/dashboard/api-keys', navLabel: 'API keys', heading: 'API keys' },
  { href: '/dashboard/webhooks', navLabel: 'Webhooks', heading: 'Webhook endpoints' },
  { href: '/dashboard/members', navLabel: 'Team', heading: 'Team' },
  { href: '/dashboard/settings', navLabel: 'Settings', heading: 'Settings' },
];

test.describe('merchant dashboard (read-only)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/dashboard');
  });

  for (const { href, navLabel, heading } of PAGES) {
    test(`nav link "${navLabel}" loads the ${heading} page`, async ({ page }) => {
      await page.getByRole('link', { name: navLabel, exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`${href.replace(/\//g, '\\/')}$`));
      await expect(page.getByRole('heading', { name: heading })).toBeVisible();
    });
  }

  test('settings page shows the seeded merchant name', async ({ page }) => {
    await page.goto('/dashboard/settings');
    // "Acme Test Store" also appears in the sidebar's merchant-name display,
    // so scope to the settings <dd> specifically to avoid a strict-mode
    // violation (two matches).
    await expect(page.getByRole('main').getByText('Acme Test Store')).toBeVisible();
  });
});
