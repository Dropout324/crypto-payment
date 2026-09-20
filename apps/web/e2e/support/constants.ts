/**
 * Fixed dev credentials created by `pnpm seed` (packages/database/prisma/seed.ts).
 * Seeding is idempotent, so re-running it between test runs is safe.
 */
export const SEED_MERCHANT = {
  email: 'merchant@example.test',
  password: 'DevPassword123!',
};

export const SEED_ADMIN = {
  email: 'admin@example.test',
  password: 'DevPassword123!',
};

/** Platform SUPPORT role - read-only, for proving admin write actions reject a lower tier than ADMIN. */
export const SEED_SUPPORT = {
  email: 'support@example.test',
  password: 'DevPassword123!',
};

/** Merchant DEVELOPER-role member of Acme Test Store - can manage API keys/webhooks but not the team. */
export const SEED_DEVELOPER = {
  email: 'developer@example.test',
  password: 'DevPassword123!',
};

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';
