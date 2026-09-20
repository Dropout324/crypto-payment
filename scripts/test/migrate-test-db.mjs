// `pnpm test:db:migrate`: apply Prisma migrations to TEST_DATABASE_URL.
// CI runs this against an empty database before `pnpm test`; locally it
// brings `gateway_test` up to date after a new migration lands.

import { spawnSync } from 'node:child_process';
import { loadLocalEnv, resolveTestDatabaseUrl } from './test-database.mjs';

loadLocalEnv();
const databaseUrl = resolveTestDatabaseUrl();

const result = spawnSync('pnpm', ['--filter', '@gateway/database', 'exec', 'prisma', 'migrate', 'deploy'], {
  stdio: 'inherit',
  // pnpm is a .cmd shim on Windows, which spawn cannot execute without a shell.
  shell: process.platform === 'win32',
  env: { ...process.env, DATABASE_URL: databaseUrl },
});

process.exit(result.status ?? 1);
