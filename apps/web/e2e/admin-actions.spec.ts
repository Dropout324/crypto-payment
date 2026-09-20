import { test, expect } from '@playwright/test';
import { API_URL } from './support/constants';
import { ADMIN_STORAGE_STATE, MERCHANT_STORAGE_STATE, SUPPORT_STORAGE_STATE } from './global-setup';
import {
  closeDb,
  createOpenDiscrepancy,
  createPendingComplianceCheck,
  createRequestedRefund,
  getSeedMerchantId,
} from './support/db-fixtures';

test.afterAll(async () => {
  await closeDb();
});

test.describe('Compliance review (ADMIN)', () => {
  test.use({ storageState: ADMIN_STORAGE_STATE });

  test('approves a pending compliance check', async ({ page }) => {
    const { subjectId } = await createPendingComplianceCheck();
    await page.goto('/admin/compliance');

    // The "Subject" column renders subject_id, not the check's own id.
    // ULIDs generated close together can share their visible 10-char
    // prefix, and rows are listed oldest-first - `.last()` picks the one
    // just created rather than an older row from a previous local run.
    const row = page.getByRole('row', { name: new RegExp(subjectId.slice(0, 10)) }).last();
    await expect(row).toBeVisible();
    await row.getByRole('button', { name: 'Approve' }).click();
    await expect(row.getByText('PASSED')).toBeVisible();
  });
});

test.describe('Merchant suspension (ADMIN)', () => {
  test.use({ storageState: ADMIN_STORAGE_STATE });

  test('suspends then reactivates the seeded merchant', async ({ page }) => {
    await page.goto('/admin/merchants');
    const row = page.getByRole('row', { name: /Acme Test Store/ });
    await expect(row).toBeVisible();

    page.once('dialog', (dialog) => dialog.accept());
    await row.getByRole('button', { name: 'Suspend' }).click();
    await expect(row.getByText('SUSPENDED')).toBeVisible();

    await row.getByRole('button', { name: 'Reactivate' }).click();
    await expect(row.getByText('ACTIVE')).toBeVisible();
  });
});

test.describe('Reconciliation discrepancy resolution (ADMIN)', () => {
  test.use({ storageState: ADMIN_STORAGE_STATE });

  test('resolves an open discrepancy with a note', async ({ page }) => {
    const { subjectId } = await createOpenDiscrepancy();
    await page.goto('/admin/reconciliation');

    // The "Subject" column renders subject_id, not the discrepancy's own id (see the compliance test's note on `.last()`).
    const row = page.getByRole('row', { name: new RegExp(subjectId.slice(0, 10)) }).last();
    await expect(row).toBeVisible();
    await row.getByPlaceholder('Resolution note').fill('Verified against exchange records.');
    await row.getByRole('button', { name: 'Resolve' }).click();
    await expect(row.getByText('open')).toHaveCount(0);
  });
});

test.describe('Refund decisions (ADMIN)', () => {
  test.use({ storageState: ADMIN_STORAGE_STATE });

  test('approves a requested refund', async ({ page }) => {
    const merchantId = await getSeedMerchantId();
    const { invoiceId } = await createRequestedRefund(merchantId);
    await page.goto('/admin/refunds');

    // The "Invoice" column renders invoice_id, not the refund's own id (see the compliance test's note on `.last()`).
    const row = page.getByRole('row', { name: new RegExp(invoiceId.slice(0, 10)) }).last();
    await expect(row).toBeVisible();
    await row.getByRole('button', { name: 'Approve' }).click();
    await expect(row.getByText('APPROVED')).toBeVisible();
  });

  test('rejects a requested refund', async ({ page }) => {
    const merchantId = await getSeedMerchantId();
    const { invoiceId } = await createRequestedRefund(merchantId);
    await page.goto('/admin/refunds');

    const row = page.getByRole('row', { name: new RegExp(invoiceId.slice(0, 10)) }).last();
    await expect(row).toBeVisible();
    page.once('dialog', (dialog) => dialog.accept());
    await row.getByRole('button', { name: 'Reject' }).click();
    await expect(row.getByText('REJECTED')).toBeVisible();
  });
});

test.describe('Audit log (ADMIN)', () => {
  test.use({ storageState: ADMIN_STORAGE_STATE });

  test('lists at least one privileged action and supports filtering by action', async ({ page }) => {
    await page.goto('/admin/audit-logs');
    await expect(page.getByRole('heading', { name: 'Audit log' })).toBeVisible();

    await page.getByLabel('Action').fill('database.seeded');
    await page.getByRole('button', { name: 'Filter' }).click();
    await expect(page).toHaveURL(/action=database\.seeded/);
    // `pnpm seed` is idempotent but re-runs still append a fresh audit row
    // each time (see seed.ts) - filtering by action can legitimately match
    // more than one row, so assert on the first rather than uniqueness.
    await expect(page.getByRole('row', { name: /database\.seeded/ }).first()).toBeVisible();
  });
});

test.describe('Operator role restrictions (SUPPORT is read-only)', () => {
  test.use({ storageState: SUPPORT_STORAGE_STATE });

  test('SUPPORT sees no write controls anywhere in /admin', async ({ page }) => {
    await createPendingComplianceCheck();
    await createOpenDiscrepancy();

    await page.goto('/admin/compliance');
    await expect(page.getByRole('button', { name: 'Approve' })).toHaveCount(0);

    await page.goto('/admin/merchants');
    await expect(page.getByRole('button', { name: 'Suspend' })).toHaveCount(0);

    await page.goto('/admin/reconciliation');
    await expect(page.getByRole('button', { name: 'Resolve' })).toHaveCount(0);

    await page.goto('/admin/refunds');
    await expect(page.getByRole('button', { name: 'Approve' })).toHaveCount(0);
  });

  test('SUPPORT has no "Audit log" nav link and is redirected away if it navigates there directly', async ({ page }) => {
    await page.goto('/admin/merchants');
    await expect(page.getByRole('link', { name: 'Audit log' })).toHaveCount(0);

    await page.goto('/admin/audit-logs');
    await expect(page).toHaveURL(/\/admin\/merchants$/);
  });

  test('the API independently rejects every SUPPORT write attempt, not just the UI', async ({ page }) => {
    const { id: checkId } = await createPendingComplianceCheck();
    const { id: discrepancyId } = await createOpenDiscrepancy();
    const merchantId = await getSeedMerchantId();
    const { id: refundId } = await createRequestedRefund(merchantId);

    const attempts = [
      page.request.post(`${API_URL}/v1/admin/compliance-checks/${checkId}/review`, { data: { decision: 'APPROVE' } }),
      page.request.post(`${API_URL}/v1/admin/merchants/${merchantId}/suspend`),
      page.request.post(`${API_URL}/v1/admin/reconciliation-discrepancies/${discrepancyId}/resolve`, {
        data: { resolution_note: 'should be rejected' },
      }),
      page.request.post(`${API_URL}/v1/admin/refunds/${refundId}/approve`),
      page.request.get(`${API_URL}/v1/admin/audit-logs`),
    ];
    const responses = await Promise.all(attempts);
    for (const response of responses) {
      expect(response.status()).toBe(403);
    }
  });
});

test.describe('Cross-boundary: a merchant user cannot reach operator/admin actions', () => {
  test.use({ storageState: MERCHANT_STORAGE_STATE });

  test('a merchant session is rejected by every admin write and read endpoint', async ({ page }) => {
    const merchantId = await getSeedMerchantId();

    const responses = await Promise.all([
      page.request.get(`${API_URL}/v1/admin/merchants`),
      page.request.post(`${API_URL}/v1/admin/merchants/${merchantId}/suspend`),
      page.request.get(`${API_URL}/v1/admin/audit-logs`),
    ]);
    for (const response of responses) {
      expect(response.status()).toBe(403);
    }
  });
});
