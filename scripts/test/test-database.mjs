// Resolution of the database integration tests run against (ADR 0020).
// Shared by the Vitest setup file and `pnpm test:db:migrate`, so "which
// database do tests touch" has exactly one answer.

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Loads the repo-root `.env` if there is one. A local convenience only:
 * `process.loadEnvFile` never overrides a variable that is already set, so
 * values exported by CI or the developer's shell always win, and CI needs no
 * `.env` file at all.
 */
export function loadLocalEnv() {
  const envFile = path.join(repoRoot, '.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);
}

/**
 * Returns TEST_DATABASE_URL, or throws. Never falls back to DATABASE_URL -
 * that is the development database, and silently running the suites there is
 * exactly the failure this exists to prevent (a dev database's backlog made
 * tests flaky; test fixtures polluted the dev database).
 */
export function resolveTestDatabaseUrl() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error(
      'TEST_DATABASE_URL is not set. Integration tests never fall back to DATABASE_URL (the development database). ' +
        'Set it in .env (see .env.example) or in the CI environment.',
    );
  }

  let databaseName;
  try {
    databaseName = decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
  } catch {
    throw new Error('TEST_DATABASE_URL is not a valid connection URL.');
  }

  // A name check is crude, but it turns "pointed the suite at the wrong
  // database" from silent data damage into an immediate, explained failure.
  if (!/test/i.test(databaseName)) {
    throw new Error(
      `TEST_DATABASE_URL points at database "${databaseName}", whose name does not contain "test". ` +
        'Refusing to run: these suites insert, back-date and expire rows freely.',
    );
  }

  return url;
}
