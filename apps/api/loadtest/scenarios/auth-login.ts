import type autocannon from 'autocannon';
import type { LoadtestFixture } from '../fixture.js';

/**
 * `POST /v1/auth/login` - Argon2id password verify (19 MiB memory, time cost
 * 2 - see `packages/security/src/password.ts`), noticeably heavier than the
 * API key's Argon2 params, so this is expected to be the lowest-throughput,
 * highest-latency scenario of the four.
 *
 * Also the `'auth'` rate-limit profile (`RATE_LIMIT_AUTH_PER_MINUTE`, default
 * 10/min in `.env.example`), keyed by IP - since every autocannon connection
 * shares one loopback IP, a run against an unmodified `.env` will start
 * returning 429s almost immediately. That is the correct, intended behaviour
 * to observe here, not a bug: see the loadtest README for how to run this
 * scenario twice, once at the real limit (to confirm 429s + `Retry-After`
 * work) and once with `RATE_LIMIT_AUTH_PER_MINUTE` raised (to measure the
 * endpoint's actual capacity).
 */
export function build(fixture: LoadtestFixture): Partial<autocannon.Options> {
  return {
    url: fixture.apiBaseUrl,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    requests: [
      {
        path: '/v1/auth/login',
        body: JSON.stringify({ email: fixture.email, password: fixture.password }),
      },
    ],
  };
}
