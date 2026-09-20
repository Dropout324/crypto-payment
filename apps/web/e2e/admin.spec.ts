import { test, expect } from '@playwright/test';
import { login } from './support/auth';
import { SEED_ADMIN, SEED_MERCHANT } from './support/constants';
import { ADMIN_STORAGE_STATE, MERCHANT_STORAGE_STATE } from './global-setup';

const PAGES: Array<{ navLabel: string; heading: string }> = [
  { navLabel: 'Merchants', heading: 'Merchants' },
  { navLabel: 'Compliance', heading: 'Compliance checks' },
  { navLabel: 'Reconciliation', heading: 'Reconciliation discrepancies' },
  { navLabel: 'Refunds', heading: 'Refunds' },
  { navLabel: 'Settlements', heading: 'Settlements' },
  { navLabel: 'Audit log', heading: 'Audit log' },
];

test('platform admin login redirects to /admin/merchants', async ({ page }) => {
  await login(page, SEED_ADMIN.email, SEED_ADMIN.password);
  await expect(page).toHaveURL(/\/admin\/merchants$/);
});

test.describe('admin dashboard (read-only)', () => {
  test.use({ storageState: ADMIN_STORAGE_STATE });

  test.beforeEach(async ({ page }) => {
    await page.goto('/admin/merchants');
  });

  for (const { navLabel, heading } of PAGES) {
    test(`nav link "${navLabel}" loads the ${heading} page`, async ({ page }) => {
      await page.getByRole('link', { name: navLabel, exact: true }).click();
      await expect(page.getByRole('heading', { name: heading })).toBeVisible();
    });
  }
});

test.describe('admin route protection', () => {
  test.use({ storageState: MERCHANT_STORAGE_STATE });

  test('a non-admin merchant user is redirected away from /admin', async ({ page }) => {
    await page.goto('/admin');
    await expect(page).toHaveURL(/\/dashboard/);
  });
});
