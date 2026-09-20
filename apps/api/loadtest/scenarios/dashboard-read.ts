import type autocannon from 'autocannon';
import type { LoadtestFixture } from '../fixture.js';

/**
 * `GET /v1/merchant/me/balance` - the dashboard's session-authenticated read
 * path (`JwtAuthGuard` + `MerchantRoleGuard`). `JwtAuthGuard` verifies a
 * stateless HS256 JWT (no DB lookup); `MerchantRoleGuard` then does one
 * `merchantMember` lookup to re-check membership on every request (by
 * design - roles are never baked into the access token). Expected to sit
 * between `public-invoice-polling` (no auth) and `invoice-creation` (Argon2)
 * on latency, since this trades Argon2 for one indexed DB read plus the
 * balance computation itself.
 *
 * `fixture.accessToken` is signed directly by `seed.ts` with the same
 * `JWT_ACCESS_SECRET`/issuer/audience the running API uses - equivalent to a
 * real login's token without spending an Argon2 verify (and the 'auth'
 * rate-limit bucket) per fixture regeneration.
 */
export function build(fixture: LoadtestFixture): Partial<autocannon.Options> {
  return {
    url: fixture.apiBaseUrl,
    method: 'GET',
    headers: {
      cookie: `gw_access=${fixture.accessToken}`,
      'x-merchant-id': fixture.merchantId,
    },
    requests: [{ path: '/v1/merchant/me/balance' }],
  };
}
