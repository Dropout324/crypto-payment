import { hashPassword } from '@gateway/security';
import type { DatabaseClient } from '@gateway/database';
import { seedMerchant, type SeededMerchant } from './seed-merchant.js';

export interface SeededMerchantLogin extends SeededMerchant {
  userId: string;
  email: string;
  password: string;
}

/**
 * A merchant plus a real, login-capable OWNER user - for testing
 * `JwtAuthGuard`/`MerchantRoleGuard`-protected dashboard routes.
 * `seedMerchant`'s owner has only a non-verifiable placeholder hash, so this
 * overwrites it with a real Argon2id hash of a known password.
 */
export async function seedMerchantWithLogin(
  db: DatabaseClient,
  overrides?: Parameters<typeof seedMerchant>[1],
): Promise<SeededMerchantLogin> {
  const merchant = await seedMerchant(db, overrides);
  const owner = await db.user.findFirstOrThrow({
    where: { memberships: { some: { merchantId: merchant.merchantId, role: 'OWNER' } } },
  });

  const password = 'CorrectHorseBatteryStaple1!';
  await db.user.update({ where: { id: owner.id }, data: { passwordHash: await hashPassword(password) } });

  return { ...merchant, userId: owner.id, email: owner.email, password };
}
