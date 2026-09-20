import { request as pwRequest } from '@playwright/test';
import { API_URL, SEED_ADMIN, SEED_DEVELOPER, SEED_MERCHANT, SEED_SUPPORT } from './support/constants';

export const MERCHANT_STORAGE_STATE = 'e2e/.auth/merchant.json';
export const ADMIN_STORAGE_STATE = 'e2e/.auth/admin.json';
export const SUPPORT_STORAGE_STATE = 'e2e/.auth/support.json';
export const DEVELOPER_STORAGE_STATE = 'e2e/.auth/developer.json';

/**
 * Logs in once per role (directly against the API, not through the login
 * UI - auth.spec.ts already covers that flow) and saves the resulting
 * session cookie as a Playwright storageState file. Every other spec reuses
 * one of these instead of logging in again.
 *
 * This isn't just a speed optimisation: `/v1/auth/login` is rate-limited to
 * RATE_LIMIT_AUTH_PER_MINUTE (10, keyed by IP - ADR 0011) per minute, and
 * every Playwright worker on this machine shares the same loopback IP. A
 * dozen-plus parallel tests each logging in through the UI reliably blew
 * through that limit and failed on login itself, not on anything the test
 * was actually checking.
 */
async function loginAndSave(email: string, password: string, outFile: string): Promise<void> {
  const ctx = await pwRequest.newContext();
  const res = await ctx.post(`${API_URL}/v1/auth/login`, { data: { email, password } });
  if (!res.ok()) {
    throw new Error(`global-setup: login failed for ${email}: ${res.status()} ${await res.text()}`);
  }
  await ctx.storageState({ path: outFile });
  await ctx.dispose();
}

export default async function globalSetup(): Promise<void> {
  await loginAndSave(SEED_MERCHANT.email, SEED_MERCHANT.password, MERCHANT_STORAGE_STATE);
  await loginAndSave(SEED_ADMIN.email, SEED_ADMIN.password, ADMIN_STORAGE_STATE);
  await loginAndSave(SEED_SUPPORT.email, SEED_SUPPORT.password, SUPPORT_STORAGE_STATE);
  await loginAndSave(SEED_DEVELOPER.email, SEED_DEVELOPER.password, DEVELOPER_STORAGE_STATE);
}
