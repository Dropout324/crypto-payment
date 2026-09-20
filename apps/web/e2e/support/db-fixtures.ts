import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { newId } from '@gateway/shared';
import { createPrismaClient, type DatabaseClient } from '@gateway/database';

/**
 * Direct Postgres access for Playwright fixture setup. There is no API
 * endpoint yet that creates a compliance check, a reconciliation
 * discrepancy or a refund (they originate from processes outside this
 * phase's scope), so this mirrors the pattern apps/api's own Vitest e2e
 * suite already uses for the exact same rows - see
 * apps/api/test/admin-compliance.e2e.test.ts,
 * apps/api/test/admin-reconciliation.e2e.test.ts and
 * apps/api/test/admin-refunds.e2e.test.ts. Requires DATABASE_URL, same as
 * `pnpm seed` (see playwright.config.ts's setup doc-comment).
 *
 * Unlike `pnpm seed` (which wraps itself in `dotenv -e .env --`), `pnpm
 * test:e2e` does not - CI supplies real environment variables directly, but
 * a local run only has `.env` on disk. Load it here, once, only when
 * DATABASE_URL isn't already present, so CI's real env vars are never
 * overridden and a local `pnpm test:e2e` still works without the caller
 * remembering to wrap it themselves.
 */
if (!process.env.DATABASE_URL) {
  // `process.cwd()` is apps/web - Playwright's config and testDir both live
  // there, and `pnpm test:e2e`/`playwright test` are always invoked from
  // that directory (see playwright.config.ts) - so the repo root is two
  // levels up regardless of which spec file imports this.
  const rootEnvPath = resolve(process.cwd(), '../../.env');
  if (existsSync(rootEnvPath)) {
    process.loadEnvFile(rootEnvPath);
  }
}

let client: DatabaseClient | null = null;

export function getDb(): DatabaseClient {
  client ??= createPrismaClient();
  return client;
}

export async function closeDb(): Promise<void> {
  if (client) {
    await client.$disconnect();
    client = null;
  }
}

/** The merchant `pnpm seed` creates (packages/database/prisma/seed.ts) - `acme-test`. */
export async function getSeedMerchantId(): Promise<string> {
  const db = getDb();
  const merchant = await db.merchant.findUniqueOrThrow({ where: { slug: 'acme-test' } });
  return merchant.id;
}

/**
 * Returns `subjectId` alongside the check's own `id` because
 * apps/web/src/app/admin/compliance/page.tsx renders the truncated
 * `subject_id` in its "Subject" column, never the check's own id - a test
 * has to locate the row by what is actually on screen.
 */
export async function createPendingComplianceCheck(): Promise<{ id: string; subjectId: string }> {
  const db = getDb();
  const id = `cc_pw_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  const subjectId = newId('invoice');
  await db.complianceCheck.create({
    data: {
      id,
      subjectType: 'invoice',
      subjectId,
      checkType: 'sanctions',
      provider: 'test-provider',
      status: 'PENDING',
    },
  });
  return { id, subjectId };
}

/** See createPendingComplianceCheck's note - the reconciliation page renders `subject_id`, not the discrepancy's own id. */
export async function createOpenDiscrepancy(): Promise<{ id: string; subjectId: string }> {
  const db = getDb();
  const runId = newId('reconciliation');
  await db.reconciliationRun.create({
    data: {
      id: runId,
      scope: 'ledger_balance',
      status: 'DISCREPANCIES_FOUND',
      periodStart: new Date(Date.now() - 3_600_000),
      periodEnd: new Date(),
    },
  });

  const discrepancyId = `disc_pw_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  const subjectId = newId('ledgerAccount');
  await db.reconciliationDiscrepancy.create({
    data: {
      id: discrepancyId,
      runId,
      kind: 'LEDGER_IMBALANCE',
      severity: 'CRITICAL',
      subjectType: 'ledger_account',
      subjectId,
      expectedValue: '100',
      actualValue: '95',
    },
  });
  return { id: discrepancyId, subjectId };
}

/** See createPendingComplianceCheck's note - the refunds page renders `invoice_id`, not the refund's own id. */
export async function createRequestedRefund(merchantId: string): Promise<{ id: string; invoiceId: string }> {
  const db = getDb();
  const invoiceId = newId('invoice');
  await db.invoice.create({
    data: {
      id: invoiceId,
      merchantId,
      orderId: `playwright-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      requestedCurrency: 'USD',
      requestedDecimals: 2,
      requestedAmount: '100',
      paymentAsset: 'USDT',
      paymentDecimals: 6,
      network: 'ETHEREUM',
      cryptoAmount: '100000000',
      underpaymentPolicy: 'MANUAL_REVIEW',
      overpaymentPolicy: 'MANUAL_REVIEW',
      underpaymentToleranceBps: 0,
      overpaymentToleranceBps: 0,
      requiredConfirmations: 12,
      status: 'PAID',
      expiresAt: new Date(Date.now() + 900_000),
    },
  });

  const refundId = newId('refund');
  await db.refund.create({
    data: {
      id: refundId,
      invoiceId,
      merchantId,
      network: 'ETHEREUM',
      assetSymbol: 'USDT',
      assetDecimals: 6,
      amount: '100000000',
      destinationAddress: '0xabc',
      destinationAddressNormalized: '0xabc',
      requestedBy: 'playwright',
      status: 'REQUESTED',
    },
  });
  return { id: refundId, invoiceId };
}
