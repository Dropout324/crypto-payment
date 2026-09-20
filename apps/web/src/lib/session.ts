import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { apiRequest, ApiError } from './api';
import type { MeResponse } from './types';

/** Resolves the current dashboard session from the incoming request's cookies, or null if unauthenticated. */
export async function getSession(): Promise<MeResponse | null> {
  const jar = await cookies();
  const cookieHeader = jar.toString();
  if (!cookieHeader) return null;

  try {
    return await apiRequest<MeResponse>('/v1/auth/me', { cookie: cookieHeader });
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return null;
    throw err;
  }
}

/** Server Component / Route Handler fetch that forwards the caller's session cookie to the API. */
export async function serverFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const jar = await cookies();
  return apiRequest<T>(path, { ...init, cookie: jar.toString() });
}

/** Like getSession, but redirects to /login instead of returning null - for pages that assume a layout already gated on session. */
export async function requireSession(): Promise<MeResponse> {
  const session = await getSession();
  if (!session) redirect('/login');
  return session;
}

const ADMIN_ROLES = new Set(['SUPPORT', 'COMPLIANCE_OFFICER', 'ADMIN']);

/** Redirects to /login (no session) or /dashboard (logged in but not an admin-capable role) - mirrors PlatformRoleGuard's default role set on the API. */
export async function requirePlatformRole(): Promise<MeResponse> {
  const session = await requireSession();
  if (!ADMIN_ROLES.has(session.user.platform_role)) redirect('/dashboard');
  return session;
}
