import { test, expect } from '@playwright/test';
import { API_URL, SEED_DEVELOPER } from './support/constants';
import { MERCHANT_STORAGE_STATE, DEVELOPER_STORAGE_STATE } from './global-setup';

test.describe('API keys', () => {
  test.use({ storageState: MERCHANT_STORAGE_STATE });

  test('create then revoke an API key from the dashboard', async ({ page }) => {
    await page.goto('/dashboard/api-keys');

    const name = `pw-key-${Date.now()}`;
    await page.getByLabel('Name').fill(name);
    await page.getByRole('button', { name: 'Create API key' }).click();

    await expect(page.getByText("won't be shown again")).toBeVisible();
    const row = page.getByRole('row', { name: new RegExp(name) });
    await expect(row).toBeVisible();
    await expect(row.getByText('ACTIVE')).toBeVisible();

    page.once('dialog', (dialog) => dialog.accept());
    await row.getByRole('button', { name: 'Revoke' }).click();
    await expect(row.getByText('REVOKED')).toBeVisible();
    await expect(row.getByRole('button', { name: 'Revoke' })).toHaveCount(0);
  });
});

test.describe('Webhook endpoints', () => {
  test.use({ storageState: MERCHANT_STORAGE_STATE });

  test('create an endpoint, toggle it, rotate its secret and send a test event', async ({ page }) => {
    await page.goto('/dashboard/webhooks');

    const url = `https://example.com/pw-webhook-${Date.now()}`;
    await page.getByLabel('URL').fill(url);
    await page.getByRole('button', { name: 'Add endpoint' }).click();

    await expect(page.getByText("won't be shown again")).toBeVisible();
    const row = page.getByRole('row', { name: new RegExp(url.replace(/[.]/g, '\\.')) });
    await expect(row).toBeVisible();
    await expect(row.getByText('ACTIVE')).toBeVisible();

    // Toggle disables it. `exact: true` because a disabled endpoint also
    // gets a "disabled by merchant" reason in a separate column, which a
    // substring match against "DISABLED" would otherwise also match.
    await row.getByText('ACTIVE').click();
    await expect(row.getByText('DISABLED', { exact: true })).toBeVisible();

    // Rotate secret shows a new one-time secret.
    page.once('dialog', (dialog) => dialog.accept());
    await row.getByRole('button', { name: 'Rotate secret' }).click();
    await expect(row.getByText('New secret - copy now:')).toBeVisible();

    // Send test event - result depends on real network reachability to
    // example.com, so assert only that some outcome was reported.
    await row.getByRole('button', { name: 'Test' }).click();
    await expect(row.getByText(/Delivered|Failed/)).toBeVisible({ timeout: 15_000 });
  });
});

test.describe('Team members (OWNER)', () => {
  test.use({ storageState: MERCHANT_STORAGE_STATE });

  test('seeded developer member is visible', async ({ page }) => {
    await page.goto('/dashboard/members');
    await expect(page.getByRole('row', { name: new RegExp(SEED_DEVELOPER.email) })).toBeVisible();
  });

  test('add a member, change their role, then remove them', async ({ page }) => {
    // admin@example.test already has an account (platform admin) but is not
    // yet a member of this merchant - AddMemberDto requires an existing
    // account and there is no invite/signup flow (members.dto.ts).
    const targetEmail = 'admin@example.test';
    await page.goto('/dashboard/members');

    // Clean slate: this account may already be a member from a previous
    // interrupted run - remove it first if so.
    const existingRow = page.getByRole('row', { name: new RegExp(targetEmail) });
    if (await existingRow.count()) {
      page.once('dialog', (dialog) => dialog.accept());
      await existingRow.getByRole('button', { name: 'Remove' }).click();
      await expect(existingRow).toHaveCount(0);
    }

    await page.getByLabel(/Email/).fill(targetEmail);
    await page.getByLabel('Role').selectOption('VIEWER');
    await page.getByRole('button', { name: 'Add member' }).click();

    const row = page.getByRole('row', { name: new RegExp(targetEmail) });
    await expect(row).toBeVisible();
    await expect(row.locator('select')).toHaveValue('VIEWER');

    await row.locator('select').selectOption('DEVELOPER');
    await expect(page.getByRole('row', { name: new RegExp(targetEmail) }).locator('select')).toHaveValue('DEVELOPER');

    page.once('dialog', (dialog) => dialog.accept());
    await row.getByRole('button', { name: 'Remove' }).click();
    await expect(page.getByRole('row', { name: new RegExp(targetEmail) })).toHaveCount(0);
  });
});

test.describe('Merchant role restrictions', () => {
  test.use({ storageState: DEVELOPER_STORAGE_STATE });

  test('a DEVELOPER can manage API keys and webhooks but not the team', async ({ page }) => {
    await page.goto('/dashboard/api-keys');
    await expect(page.getByRole('button', { name: 'Create API key' })).toBeVisible();

    await page.goto('/dashboard/webhooks');
    await expect(page.getByRole('button', { name: 'Add endpoint' })).toBeVisible();

    await page.goto('/dashboard/members');
    await expect(page.getByRole('button', { name: 'Add member' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Remove' })).toHaveCount(0);
  });

  test('the API independently rejects a DEVELOPER managing members, not just the UI', async ({ page }) => {
    const meResponse = await page.request.get(`${API_URL}/v1/auth/me`);
    const me = (await meResponse.json()) as { memberships: Array<{ merchant_id: string; role: string }> };
    const membership = me.memberships[0]!;
    expect(membership.role).toBe('DEVELOPER');

    const response = await page.request.post(`${API_URL}/v1/merchant/me/members`, {
      headers: { 'x-merchant-id': membership.merchant_id },
      data: { email: 'admin@example.test', role: 'VIEWER' },
    });
    expect(response.status()).toBe(403);
  });
});
