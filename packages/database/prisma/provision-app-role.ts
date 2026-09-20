/**
 * Least-privilege application database role (Phase 17 pass 1, ADR 0031).
 *
 * Every runtime service (`api`, `worker`, `blockchain-monitor`) used to
 * connect to Postgres as `gateway` - the same role migrations run as, and in
 * `infrastructure/kubernetes/postgres.yaml` a superuser (needed there only so
 * `pg_basebackup`/streaming replication for point-in-time recovery, ADR 0029,
 * has a role to authenticate as). A bug or an injected raw query in
 * application code had no database-enforced ceiling: it could run DDL, touch
 * any schema, or drop a table outright.
 *
 * This script creates `gateway_app` - LOGIN only, no CREATEDB/CREATEROLE/
 * SUPERUSER/REPLICATION - and grants it exactly SELECT/INSERT/UPDATE/DELETE
 * on tables and USAGE/SELECT on sequences, via `ALTER DEFAULT PRIVILEGES FOR
 * ROLE <migrator>` so tables a future migration creates are covered
 * automatically without re-running this script. Idempotent: safe to run
 * against a database that already has the role (`CREATE ROLE ... IF NOT
 * EXISTS` does not exist in Postgres, so this uses a `DO` block instead),
 * and safe to run before or after migrations have created any tables.
 *
 * Must run connected as the role that owns (or will own) the schema's
 * tables - i.e. the same role `prisma migrate deploy` uses - because
 * `ALTER DEFAULT PRIVILEGES FOR ROLE CURRENT_USER` only takes effect for
 * objects the connected role itself creates afterwards. Uses `PrismaClient`
 * with raw SQL rather than a new `pg` dependency - schema-mapped model
 * methods are irrelevant here, but `$executeRawUnsafe` works against any
 * Postgres connection exactly like `runInTransaction`'s advisory-lock helper
 * already relies on for non-model SQL.
 *
 * Usage: `pnpm db:provision-app-role` (uses `DATABASE_URL` as the migrator
 * connection and `GATEWAY_APP_DB_PASSWORD` for the new role's password), or
 * `TARGET_DATABASE_URL=... pnpm db:provision-app-role` to provision a
 * database other than the one `DATABASE_URL` points at (used by the test
 * suite, which provisions the role into `gateway_test`, and by
 * `infrastructure/kubernetes/migration-job.yaml`).
 */

import { PrismaClient } from '@prisma/client';

const APP_ROLE_NAME = process.env.GATEWAY_APP_DB_ROLE ?? 'gateway_app';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing required environment variable: ${name}`);
  return value;
}

export async function provisionAppRole(options: {
  /** Connection string for the role that owns the schema (the migration role) - `ALTER DEFAULT PRIVILEGES` runs as this role. */
  migratorDatabaseUrl: string;
  roleName?: string;
  password: string;
}): Promise<void> {
  const roleName = options.roleName ?? APP_ROLE_NAME;
  const client = new PrismaClient({ datasources: { db: { url: options.migratorDatabaseUrl } } });

  try {
    await client.$connect();

    // Quoted-literal interpolation is safe here: both inputs are deployment
    // configuration (an env var and a fixed role name), never request-derived
    // data - and Postgres does not accept bind parameters inside DDL/role
    // statements, so `$executeRaw` tagged templates cannot be used for these.
    const escapedPassword = options.password.replace(/'/g, "''");
    await client.$executeRawUnsafe(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${roleName}') THEN
          CREATE ROLE ${roleName} LOGIN PASSWORD '${escapedPassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
        ELSE
          ALTER ROLE ${roleName} WITH LOGIN PASSWORD '${escapedPassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
        END IF;
      END
      $$;
    `);

    const currentDb = await client.$queryRawUnsafe<{ current_database: string }[]>('SELECT current_database()');
    const dbName = currentDb[0]?.current_database;
    if (!dbName) throw new Error('could not determine current database name');

    await client.$executeRawUnsafe(`GRANT CONNECT ON DATABASE "${dbName}" TO ${roleName}`);
    await client.$executeRawUnsafe(`GRANT USAGE ON SCHEMA public TO ${roleName}`);
    // Applies to tables/sequences that already exist (idempotent re-run after
    // migrations have created some).
    await client.$executeRawUnsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${roleName}`);
    await client.$executeRawUnsafe(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${roleName}`);
    // Applies to tables/sequences a future `prisma migrate deploy` (run as
    // the connected role) creates - the entire reason this script does not
    // need to be re-run after every migration.
    await client.$executeRawUnsafe(
      `ALTER DEFAULT PRIVILEGES FOR ROLE CURRENT_USER IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${roleName}`,
    );
    await client.$executeRawUnsafe(
      `ALTER DEFAULT PRIVILEGES FOR ROLE CURRENT_USER IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${roleName}`,
    );
    // No CREATE on the schema: `gateway_app` can read/write rows in tables
    // that already exist, never create new tables or types itself.
    await client.$executeRawUnsafe(`REVOKE CREATE ON SCHEMA public FROM ${roleName}`);
  } finally {
    await client.$disconnect();
  }
}

async function main() {
  const migratorDatabaseUrl = process.env.TARGET_DATABASE_URL ?? requireEnv('DATABASE_URL');
  const password = requireEnv('GATEWAY_APP_DB_PASSWORD');
  await provisionAppRole({ migratorDatabaseUrl, password });
  // CLI-only output (see the guard below) - never runs as part of a
  // request path, same posture as apps/api/src/main.ts's own startup logs.
  // eslint-disable-next-line no-console
  console.log(`provisioned least-privilege role "${APP_ROLE_NAME}"`);
}

// Only run when invoked directly (`tsx provision-app-role.ts`), not when
// imported by a test.
if (process.argv[1]?.endsWith('provision-app-role.ts')) {
  main().catch((error) => {
    // eslint-disable-next-line no-console
    console.error(error);
    process.exit(1);
  });
}
