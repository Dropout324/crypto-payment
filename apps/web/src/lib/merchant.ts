import { cookies } from 'next/headers';
import { serverFetch } from './session';
import type { Membership } from './types';

const MERCHANT_COOKIE = 'gw_merchant';

/**
 * A user's memberships aren't baked into the access JWT (see
 * MerchantRoleGuard on the API), so the dashboard tracks which merchant is
 * "current" itself, in a plain (non-httpOnly) cookie the switcher writes
 * client-side, and sends it back as `X-Merchant-Id` on every merchant-scoped
 * request - same contract the API guard expects.
 */
export async function resolveCurrentMerchantId(memberships: Membership[]): Promise<string | null> {
  if (memberships.length === 0) return null;

  const jar = await cookies();
  const selected = jar.get(MERCHANT_COOKIE)?.value;
  if (selected && memberships.some((m) => m.merchant_id === selected)) return selected;

  return memberships[0]!.merchant_id;
}

export function merchantFetch<T>(path: string, merchantId: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set('x-merchant-id', merchantId);
  return serverFetch<T>(path, { ...init, headers });
}
