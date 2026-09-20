import type { DatabaseClient } from '@gateway/database';
import { seedUser, type SeededUser } from './seed-user.js';

/** A login-capable platform-role user (default ADMIN) for admin API tests. */
export function seedAdminUser(
  db: DatabaseClient,
  platformRole: 'SUPPORT' | 'COMPLIANCE_OFFICER' | 'ADMIN' = 'ADMIN',
): Promise<SeededUser> {
  return seedUser(db, { platformRole });
}
