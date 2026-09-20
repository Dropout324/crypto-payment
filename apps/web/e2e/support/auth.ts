import type { Page } from '@playwright/test';

/**
 * Logs in through the real login form (not an API shortcut) and waits for the
 * post-login redirect, so every test that uses this also exercises the
 * cookie-session login flow itself.
 */
export async function login(page: Page, email: string, password: string, next?: string): Promise<void> {
  const target = next ? `/login?next=${encodeURIComponent(next)}` : '/login';
  await page.goto(target);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  if (next) {
    await page.waitForURL(`**${next}`);
  } else {
    await page.waitForURL((url) => url.pathname !== '/login');
  }
}
