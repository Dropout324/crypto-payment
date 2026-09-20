/**
 * Runs before any test file's imports resolve (Vitest loads `setupFiles`
 * first). `AppModule` reads `process.env` at import time via
 * `loadConfig()`, so these must be set before anything imports it -
 * setting them inside a test file's own body would be too late.
 *
 * Every value here is an unconditional assignment, not `??=` (ADR 0020).
 * This suite must be hermetic - deterministic from a clean shell AND
 * deterministic if the caller's shell happens to already have the repo
 * root's `.env` loaded (a real `RATE_LIMIT_*` value from `.env` is small
 * enough, and shared across every e2e file's one loopback-IP identity
 * closely enough, that it used to trip unrelated tests' 429s the moment
 * `.env` was in scope - `??=` let it win). `apps/api`'s suite is the one
 * intentionally NOT wired to read `.env` at all (see `scripts/test/
 * test-database.mjs` and ADR 0020) - these are its only source of truth.
 */
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgresql://postgres@127.0.0.1:5432/gateway_test?schema=public';
process.env.JWT_ACCESS_SECRET = 'test-access-secret-0123456789abcdef0123456789abcdef';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-0123456789abcdef0123456789abcdef';
process.env.ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
process.env.ENCRYPTION_KEY_ID = 'test-key';
process.env.EXCHANGE_RATE_PROVIDERS = 'coingecko';
process.env.CORS_ALLOWED_ORIGINS = 'http://localhost:3000';
process.env.REDIS_URL = 'redis://127.0.0.1:6379';
process.env.REDIS_CACHE_DB = '0';
// Every e2e file's requests appear to come from the same loopback IP, so a
// production-sized limit would make unrelated tests trip each other's
// rate-limit bucket. Functional tests get an effectively unlimited ceiling;
// rate-limit.e2e.test.ts overrides APP_CONFIG directly to exercise the real,
// small limit end-to-end.
process.env.RATE_LIMIT_API_PER_MINUTE = '1000000';
process.env.RATE_LIMIT_AUTH_PER_MINUTE = '1000000';
process.env.RATE_LIMIT_INVOICE_CREATE_PER_MINUTE = '1000000';
// Metrics/ops server is only started from main.ts (production), never from
// the e2e harness (create-test-app.ts) - nothing here reads METRICS_*.
process.env.LOG_LEVEL = process.env.TEST_LOG_LEVEL ?? 'silent';
