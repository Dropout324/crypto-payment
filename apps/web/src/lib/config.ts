// The browser talks to the API directly (not through a Next.js proxy):
// `gw_access`/`gw_refresh` are `sameSite: 'lax'` with no explicit domain, and
// SameSite is scoped by registrable domain, not by port - so localhost:3000
// and localhost:4000 are already same-site in dev, and app.example.com /
// api.example.com share one in production. See apps/api/src/auth/cookies.ts.
export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';
