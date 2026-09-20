import { newId } from '@gateway/shared';
import { hashPassword } from '@gateway/security';
import type { DatabaseClient } from '@gateway/database';

export interface SeededUser {
  userId: string;
  email: string;
  password: string;
}

/**
 * Creates an isolated, uniquely-named, login-capable user for one test.
 *
 * Unlike `seedMerchant`'s placeholder `passwordHash`, this hashes a real
 * password with Argon2id so login tests exercise real verification.
 */
export async function seedUser(
  db: DatabaseClient,
  overrides: Partial<{
    platformRole: 'USER' | 'SUPPORT' | 'COMPLIANCE_OFFICER' | 'ADMIN';
    status: 'ACTIVE' | 'SUSPENDED' | 'DISABLED';
    password: string;
  }> = {},
): Promise<SeededUser> {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const email = `auth-test-${suffix}@example.test`;
  const password = overrides.password ?? 'CorrectHorseBatteryStaple1!';
  const userId = newId('user');

  await db.user.create({
    data: {
      id: userId,
      email,
      passwordHash: await hashPassword(password),
      platformRole: overrides.platformRole ?? 'USER',
      status: overrides.status ?? 'ACTIVE',
    },
  });

  return { userId, email, password };
}
