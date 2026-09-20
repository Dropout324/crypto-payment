import { test, expect } from '@playwright/test';
import { login } from './support/auth';
import { SEED_MERCHANT } from './support/constants';

test.describe('login and session gating', () => {
  test('visiting a protected page while signed out redirects to login with a next param', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page).toHaveURL(/\/login\?next=%2Fdashboard|\/login\?next=\/dashboard/);
  });

  test('wrong password shows an error and stays on the login page', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('Email').fill(SEED_MERCHANT.email);
    await page.getByLabel('Password').fill('not-the-password');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByText(/invalid email or password/i)).toBeVisible();
    await expect(page).toHaveURL(/\/login/);
  });

  test('correct credentials land on the merchant dashboard and expose logout', async ({ page }) => {
    await login(page, SEED_MERCHANT.email, SEED_MERCHANT.password, '/dashboard');
    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(page.getByText(SEED_MERCHANT.email)).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
  });

  test('logout clears the session and protected pages redirect again', async ({ page }) => {
    await login(page, SEED_MERCHANT.email, SEED_MERCHANT.password, '/dashboard');
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/login/);

    await page.goto('/dashboard');
    await expect(page).toHaveURL(/\/login/);
  });
});
