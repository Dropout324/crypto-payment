/**
 * Development seed (SPEC section 32).
 *
 * Creates a test merchant with working credentials so a developer can call the
 * API within a minute of cloning. The generated API key and webhook secret are
 * printed ONCE - exactly as they will be for a real merchant, because the
 * database only ever stores their hash/ciphertext.
 *
 * Refuses to run against a non-development database: seeded credentials are
 * published in the repository's docs and must never exist in production.
 */

import { randomUUID } from 'node:crypto';
import { Network, listAssets, newId } from '@gateway/shared';
import {
  EnvKeyProvider,
  encryptSecret,
  generateApiKey,
  generateWebhookSecret,
  hashPassword,
  secretFingerprint,
} from '@gateway/security';
import { PrismaClient } from '@prisma/client';
import {
  LedgerAccountKind,
  ledgerAccountCode,
  ledgerAccountName,
  ledgerAccountType,
} from '../src/ledger-accounts.js';

const SEED_EMAIL = 'merchant@example.test';
const SEED_PASSWORD = 'DevPassword123!';
const SEED_MERCHANT_SLUG = 'acme-test';

function assertDevelopmentEnvironment(): void {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('refusing to seed: NODE_ENV=production');
  }

  const url = process.env.DATABASE_URL ?? '';
  const isLocal = /@(localhost|127\.0\.0\.1|postgres)[:/]/.test(url);
  if (!isLocal && process.env.SEED_ALLOW_REMOTE !== 'true') {
    throw new Error(
      `refusing to seed a non-local database (${url.replace(/:[^:@]*@/, ':***@')}). ` +
        'Set SEED_ALLOW_REMOTE=true only if you are certain.',
    );
  }
}

async function main(): Promise<void> {
  assertDevelopmentEnvironment();

  const db = new PrismaClient();
  const keyProvider = new EnvKeyProvider();

  try {
    // --- Platform admin -----------------------------------------------------
    const adminId = newId('user');
    await db.user.upsert({
      where: { email: 'admin@example.test' },
      update: {},
      create: {
        id: adminId,
        email: 'admin@example.test',
        passwordHash: await hashPassword(SEED_PASSWORD),
        fullName: 'Platform Admin',
        platformRole: 'ADMIN',
        status: 'ACTIVE',
        emailVerifiedAt: new Date(),
      },
    });

    // --- Platform support user (read-only admin role) -----------------------
    // Used by apps/web's Playwright suite to prove permission boundaries
    // narrower than ADMIN: SUPPORT can view every admin list but must be
    // rejected by compliance review, merchant suspend/reactivate,
    // reconciliation resolve and refund approve/reject (see permissions.ts).
    await db.user.upsert({
      where: { email: 'support@example.test' },
      update: {},
      create: {
        id: newId('user'),
        email: 'support@example.test',
        passwordHash: await hashPassword(SEED_PASSWORD),
        fullName: 'Platform Support',
        platformRole: 'SUPPORT',
        status: 'ACTIVE',
        emailVerifiedAt: new Date(),
      },
    });

    // --- Merchant owner -----------------------------------------------------
    const existingUser = await db.user.findUnique({ where: { email: SEED_EMAIL } });
    const userId = existingUser?.id ?? newId('user');

    if (!existingUser) {
      await db.user.create({
        data: {
          id: userId,
          email: SEED_EMAIL,
          passwordHash: await hashPassword(SEED_PASSWORD),
          fullName: 'Test Merchant Owner',
          platformRole: 'USER',
          status: 'ACTIVE',
          emailVerifiedAt: new Date(),
        },
      });
    }

    // --- Merchant -----------------------------------------------------------
    const existingMerchant = await db.merchant.findUnique({ where: { slug: SEED_MERCHANT_SLUG } });
    const merchantId = existingMerchant?.id ?? newId('merchant');

    if (!existingMerchant) {
      await db.merchant.create({
        data: {
          id: merchantId,
          name: 'Acme Test Store',
          slug: SEED_MERCHANT_SLUG,
          status: 'ACTIVE',
          countryCode: 'ID',
          websiteUrl: 'https://acme.example.test',
          supportEmail: 'support@acme.example.test',
          settlementCurrency: 'USD',
          // Mode B by default: the gateway watches merchant-owned addresses and
          // never holds their keys. See docs/decisions/0002.
          walletMode: 'MERCHANT_CONTROLLED',
          underpaymentPolicy: 'MANUAL_REVIEW',
          overpaymentPolicy: 'MANUAL_REVIEW',
          invoiceExpirySeconds: 900,
          feeBps: 100,
          kybStatus: 'PASSED',
          kybCompletedAt: new Date(),
          members: { create: { id: newId('merchantMember'), userId, role: 'OWNER' } },
        },
      });
    }

    // --- Merchant developer-role member --------------------------------------
    // Used by apps/web's Playwright suite to prove MerchantPermission.MEMBERS_MANAGE
    // is OWNER-only: a DEVELOPER can manage API keys/webhooks but must be
    // rejected adding, changing the role of, or removing a team member.
    const existingDeveloper = await db.user.findUnique({ where: { email: 'developer@example.test' } });
    const developerId = existingDeveloper?.id ?? newId('user');
    if (!existingDeveloper) {
      await db.user.create({
        data: {
          id: developerId,
          email: 'developer@example.test',
          passwordHash: await hashPassword(SEED_PASSWORD),
          fullName: 'Test Merchant Developer',
          platformRole: 'USER',
          status: 'ACTIVE',
          emailVerifiedAt: new Date(),
        },
      });
    }
    await db.merchantMember.upsert({
      where: { merchantId_userId: { merchantId, userId: developerId } },
      update: {},
      create: { id: newId('merchantMember'), merchantId, userId: developerId, role: 'DEVELOPER' },
    });

    // --- API key (test mode) ------------------------------------------------
    const apiKey = await generateApiKey('test');
    await db.apiKey.create({
      data: {
        id: newId('apiKey'),
        merchantId,
        name: 'Seed development key',
        keyPrefix: apiKey.keyPrefix,
        secretHash: apiKey.secretHash,
        livemode: false,
        scopes: ['invoices:read', 'invoices:write', 'transactions:read', 'balance:read'],
        status: 'ACTIVE',
      },
    });

    // --- Webhook endpoint ---------------------------------------------------
    const webhookSecret = generateWebhookSecret();
    await db.webhookEndpoint.create({
      data: {
        id: newId('webhookEndpoint'),
        merchantId,
        url: 'https://webhook.site/replace-me',
        eventTypes: [],
        secretEncrypted: encryptSecret(webhookSecret, keyProvider),
        secretFingerprint: secretFingerprint(webhookSecret),
        enabled: true,
      },
    });

    // --- Chart of accounts --------------------------------------------------
    // Platform-wide and merchant-scoped accounts for every asset we support, so
    // the first payment does not have to create accounts on the hot path.
    const platformKinds = [
      LedgerAccountKind.CUSTOMER_INFLOW,
      LedgerAccountKind.CUSTOMER_REFUND,
      LedgerAccountKind.FEE_REVENUE,
      LedgerAccountKind.NETWORK_FEE_EXPENSE,
      LedgerAccountKind.SUSPENSE,
      LedgerAccountKind.GATEWAY_HOLDINGS,
    ] as const;
    const merchantKinds = [
      LedgerAccountKind.MERCHANT_PAYABLE,
      LedgerAccountKind.MERCHANT_HOLDINGS,
    ] as const;

    let accountsCreated = 0;
    for (const asset of listAssets()) {
      const network = asset.network as Network;

      for (const kind of platformKinds) {
        const code = ledgerAccountCode({ kind, network, assetSymbol: asset.symbol });
        await db.ledgerAccount.upsert({
          where: { code },
          update: {},
          create: {
            id: newId('ledgerAccount'),
            code,
            name: ledgerAccountName({ kind, network, assetSymbol: asset.symbol }),
            type: ledgerAccountType(kind),
            assetSymbol: asset.symbol,
            assetDecimals: asset.decimals,
            network,
          },
        });
        accountsCreated += 1;
      }

      for (const kind of merchantKinds) {
        const code = ledgerAccountCode({ kind, network, assetSymbol: asset.symbol, merchantId });
        await db.ledgerAccount.upsert({
          where: { code },
          update: {},
          create: {
            id: newId('ledgerAccount'),
            code,
            name: ledgerAccountName({ kind, network, assetSymbol: asset.symbol, merchantId }),
            type: ledgerAccountType(kind),
            merchantId,
            assetSymbol: asset.symbol,
            assetDecimals: asset.decimals,
            network,
          },
        });
        accountsCreated += 1;
      }
    }

    // --- Chain cursors ------------------------------------------------------
    // Deliberately NOT pre-created here. `ChainScanner.loadCursor`
    // (apps/blockchain-monitor) creates its own row the first time it runs for
    // a network, starting one block behind the CURRENT chain tip - a payment
    // gateway only needs to observe activity from the moment it starts
    // watching. Seeding a row at block 0 here would defeat that: the scanner
    // would see an existing cursor and dutifully catch up from genesis,
    // millions of blocks behind, before ever reaching real time.

    // --- Audit trail --------------------------------------------------------
    await db.auditLog.create({
      data: {
        id: newId('auditLog'),
        actorType: 'system',
        actorId: 'seed',
        action: 'database.seeded',
        resourceType: 'merchant',
        resourceId: merchantId,
        requestId: randomUUID(),
        metadata: { accountsCreated },
      },
    });

    // --- Output -------------------------------------------------------------
    // These values are unrecoverable after this point; the database holds only
    // the Argon2 hash and the AES-GCM ciphertext.
    process.stdout.write(
      [
        '',
        '='.repeat(72),
        ' SEED COMPLETE - development credentials (shown once)',
        '='.repeat(72),
        `  Dashboard login : ${SEED_EMAIL} / ${SEED_PASSWORD} (OWNER)`,
        `  Platform admin  : admin@example.test / ${SEED_PASSWORD} (ADMIN)`,
        `  Platform support: support@example.test / ${SEED_PASSWORD} (SUPPORT, read-only)`,
        `  Merchant dev    : developer@example.test / ${SEED_PASSWORD} (DEVELOPER, no team management)`,
        `  Merchant        : Acme Test Store (${merchantId})`,
        '',
        `  API key         : ${apiKey.plaintext}`,
        `  Webhook secret  : ${webhookSecret}`,
        '',
        `  Ledger accounts : ${accountsCreated}`,
        '',
        '  Try it:',
        `    curl -H "Authorization: Bearer ${apiKey.plaintext}" \\`,
        '         http://localhost:4000/v1/merchant/balance',
        '='.repeat(72),
        '',
      ].join('\n'),
    );
  } finally {
    await db.$disconnect();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`seed failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
