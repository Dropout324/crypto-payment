/**
 * Vitest `setupFiles` entry for every suite that talks to PostgreSQL
 * (ADR 0020). Runs in each test worker before any test file is imported, so
 * it decides which database `createPrismaClient()` - which reads
 * `DATABASE_URL` - reaches. Production code has no notion of a test
 * database; the redirection happens here and nowhere else.
 */
import { loadLocalEnv, resolveTestDatabaseUrl } from './test-database.mjs';

loadLocalEnv();

process.env.DATABASE_URL = resolveTestDatabaseUrl();
process.env.NODE_ENV = 'test';
// Suites assert on behaviour, not log output, and `.env` commonly sets
// LOG_LEVEL=debug for local runs. TEST_LOG_LEVEL turns logs back on when
// debugging a failure.
process.env.LOG_LEVEL = process.env.TEST_LOG_LEVEL ?? 'silent';
