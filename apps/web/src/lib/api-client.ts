// Thin verb helpers for Client Components. The browser already carries the
// `gw_access` cookie itself, so no cookie forwarding is needed here (compare
// lib/session.ts, which forwards it explicitly for server-side requests).
//
// Merchant-scoped mutations also need `X-Merchant-Id` (see lib/merchant.ts's
// `merchantFetch` for the server-side equivalent) - the optional `merchantId`
// parameter below adds it, since a Client Component has no access to the
// `next/headers` cookie jar that `resolveCurrentMerchantId` reads from.
import { apiRequest } from './api';

function withMerchantId(init: RequestInit, merchantId?: string): RequestInit {
  if (!merchantId) return init;
  const headers = new Headers(init.headers);
  headers.set('x-merchant-id', merchantId);
  return { ...init, headers };
}

export function apiGet<T>(path: string): Promise<T> {
  return apiRequest<T>(path);
}

export function apiPost<T>(path: string, body?: unknown, merchantId?: string): Promise<T> {
  return apiRequest<T>(
    path,
    withMerchantId({ method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) }, merchantId),
  );
}

export function apiPatch<T>(path: string, body?: unknown, merchantId?: string): Promise<T> {
  return apiRequest<T>(
    path,
    withMerchantId({ method: 'PATCH', body: body === undefined ? undefined : JSON.stringify(body) }, merchantId),
  );
}

export function apiDelete<T>(path: string, merchantId?: string): Promise<T> {
  return apiRequest<T>(path, withMerchantId({ method: 'DELETE' }, merchantId));
}
