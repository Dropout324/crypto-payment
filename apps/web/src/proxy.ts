import { NextResponse, type NextRequest } from 'next/server';

/**
 * Cheap, edge-only gate: bounce anonymous requests away from protected
 * sections before they render. This is NOT the authoritative check - the
 * `gw_access` JWT's signature and expiry are only verified server-side by
 * `JwtAuthGuard` on the API, and `getSession()` (lib/session.ts) re-derives
 * the real session for every dashboard/admin layout on every request.
 */
export function proxy(request: NextRequest): NextResponse {
  const hasSession = request.cookies.has('gw_access');
  const { pathname } = request.nextUrl;

  if (!hasSession && (pathname.startsWith('/dashboard') || pathname.startsWith('/admin'))) {
    const url = new URL('/login', request.url);
    url.searchParams.set('next', pathname);
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/dashboard/:path*', '/admin/:path*'],
};
