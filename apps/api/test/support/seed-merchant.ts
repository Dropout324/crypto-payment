import { newId } from '@gateway/shared';
import { generateApiKey } from '@gateway/security';
import type { DatabaseClient } from '@gateway/database';
import { ALL_API_KEY_SCOPES } from '../../src/auth/api-key-scope.guard.js';

export interface SeededMerchant {
  merchantId: string;
  apiKeyPlaintext: string;
}

/**
 * Creates an isolated, uniquely-named merchant + active API key for one
 * test. The key carries every scope, and is a *live* key, by default - most
 * tests exercise several API-key-guarded endpoints against the suite's own
 * default network (`ETHEREUM`, a mainnet - see e.g. `invoices.e2e.test.ts`)
 * and are not themselves testing scope or livemode/network enforcement, so a
 * narrowly-scoped or test-mode key would make them fail for the wrong
 * reason. Pass `scopes`/`livemode` to get a deliberately restricted key for
 * a test that *is* about enforcement.
 */
export async function seedMerchant(
  db: DatabaseClient,
  overrides: Partial<{
    underpaymentPolicy: 'REJECT' | 'ACCEPT_PARTIAL' | 'REQUEST_ADDITIONAL' | 'MANUAL_REVIEW';
    overpaymentPolicy: 'ACCEPT_FULL' | 'CREDIT_DIFFERENCE' | 'REFUND_DIFFERENCE' | 'MANUAL_REVIEW';
    invoiceExpirySeconds: number;
    livemode: boolean;
    scopes: string[];
  }> = {},
): Promise<SeededMerchant> {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const userId = newId('user');
  await db.user.create({
    data: {
      id: userId,
      email: `test-${suffix}@example.test`,
      passwordHash: 'argon2id$placeholder',
      platformRole: 'USER',
      status: 'ACTIVE',
    },
  });

  const merchantId = newId('merchant');
  await db.merchant.create({
    data: {
      id: merchantId,
      name: `Test Merchant ${suffix}`,
      slug: `test-${suffix}`,
      status: 'ACTIVE',
      underpaymentPolicy: overrides.underpaymentPolicy ?? 'MANUAL_REVIEW',
      overpaymentPolicy: overrides.overpaymentPolicy ?? 'MANUAL_REVIEW',
      invoiceExpirySeconds: overrides.invoiceExpirySeconds ?? 900,
      members: { create: { id: newId('merchantMember'), userId, role: 'OWNER' } },
    },
  });

  const livemode = overrides.livemode ?? true;
  const key = await generateApiKey(livemode ? 'live' : 'test');
  await db.apiKey.create({
    data: {
      id: newId('apiKey'),
      merchantId,
      name: 'test key',
      keyPrefix: key.keyPrefix,
      secretHash: key.secretHash,
      livemode,
      scopes: overrides.scopes ?? [...ALL_API_KEY_SCOPES],
      status: 'ACTIVE',
    },
  });

  return { merchantId, apiKeyPlaintext: key.plaintext };
}

export async function seedDepositAddress(
  db: DatabaseClient,
  params: { merchantId: string; network: string; asset: string; address: string },
): Promise<string> {
  const id = newId('paymentAddress');
  await db.paymentAddress.create({
    data: {
      id,
      merchantId: params.merchantId,
      network: params.network as never,
      address: params.address,
      addressNormalized: params.address.toLowerCase(),
      assetSymbol: params.asset,
      status: 'AVAILABLE',
    },
  });
  return id;
}
