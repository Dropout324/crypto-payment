import { newId } from '@gateway/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type PrismaClient, createPrismaClient } from '../src/index.js';
import { provisionAppRole } from '../prisma/provision-app-role.js';

/**
 * Proves the least-privilege application role (Phase 17 pass 1, ADR 0031)
 * actually is least-privilege, by connecting as it and exercising both the
 * operations it must be able to do and the ones it must not - not by
 * inspecting the grant statements and trusting they work.
 *
 * `TEST_DATABASE_URL`'s own role (whatever ran migrations - `gateway`
 * locally and in CI) plays the "migrator" role `provisionAppRole` needs:
 * `ALTER DEFAULT PRIVILEGES FOR ROLE CURRENT_USER` only takes effect for
 * objects that role itself creates, which is exactly what ran the test
 * database's migrations.
 */

const ROLE_PASSWORD = 'least-privilege-role-test-password-not-a-real-secret';

function withCredentials(databaseUrl: string, username: string, password: string): string {
  const url = new URL(databaseUrl);
  url.username = username;
  url.password = password;
  return url.toString();
}

let migrator: PrismaClient;
let appRoleClient: PrismaClient;
let appRoleName: string;

beforeAll(async () => {
  const migratorUrl = process.env.TEST_DATABASE_URL;
  if (!migratorUrl) throw new Error('TEST_DATABASE_URL is not set');

  migrator = createPrismaClient({ databaseUrl: migratorUrl });
  await migrator.$connect();

  await provisionAppRole({ migratorDatabaseUrl: migratorUrl, password: ROLE_PASSWORD });
  appRoleName = process.env.GATEWAY_APP_DB_ROLE ?? 'gateway_app';

  const appRoleUrl = withCredentials(migratorUrl, appRoleName, ROLE_PASSWORD);
  appRoleClient = createPrismaClient({ databaseUrl: appRoleUrl });
  await appRoleClient.$connect();
});

afterAll(async () => {
  await appRoleClient.$disconnect();
  await migrator.$disconnect();
});

describe('gateway_app least-privilege database role', () => {
  it('can select, insert, update and delete rows in an existing table', async () => {
    const userId = newId('user');
    const email = `least-privilege-${Date.now()}@test.local`;

    await appRoleClient.user.create({
      data: { id: userId, email, passwordHash: 'argon2id$placeholder', platformRole: 'USER', status: 'ACTIVE' },
    });

    const found = await appRoleClient.user.findUnique({ where: { id: userId } });
    expect(found?.email).toBe(email);

    await appRoleClient.user.update({ where: { id: userId }, data: { fullName: 'Least Privilege Test' } });
    const updated = await appRoleClient.user.findUnique({ where: { id: userId } });
    expect(updated?.fullName).toBe('Least Privilege Test');

    await appRoleClient.user.delete({ where: { id: userId } });
    expect(await appRoleClient.user.findUnique({ where: { id: userId } })).toBeNull();
  });

  it('cannot create a new table', async () => {
    await expect(
      appRoleClient.$executeRawUnsafe('CREATE TABLE least_privilege_probe (id int)'),
    ).rejects.toThrow(/permission denied/i);
  });

  it('cannot alter an existing table', async () => {
    await expect(
      appRoleClient.$executeRawUnsafe('ALTER TABLE users ADD COLUMN least_privilege_probe int'),
    ).rejects.toThrow(/must be owner/i);
  });

  it('cannot drop an existing table', async () => {
    await expect(appRoleClient.$executeRawUnsafe('DROP TABLE users')).rejects.toThrow(/must be owner/i);
  });

  it('cannot grant itself superuser or create-role privileges', async () => {
    await expect(
      appRoleClient.$executeRawUnsafe(`ALTER ROLE ${appRoleName} WITH SUPERUSER`),
    ).rejects.toThrow(/permission denied/i);
  });

  it('automatically receives privileges on a table created after role provisioning (ALTER DEFAULT PRIVILEGES)', async () => {
    const probeTable = `least_privilege_default_priv_probe_${Date.now()}`;
    try {
      await migrator.$executeRawUnsafe(`CREATE TABLE "${probeTable}" (id int primary key)`);

      await appRoleClient.$executeRawUnsafe(`INSERT INTO "${probeTable}" (id) VALUES (1)`);
      const rows: Array<{ id: number }> = await appRoleClient.$queryRawUnsafe(`SELECT id FROM "${probeTable}"`);
      expect(rows).toEqual([{ id: 1 }]);
    } finally {
      await migrator.$executeRawUnsafe(`DROP TABLE IF EXISTS "${probeTable}"`);
    }
  });
});
