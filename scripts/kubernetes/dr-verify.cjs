#!/usr/bin/env node
// DR drill verification (Phase 14, ADR 0028). Runs the SAME ledger
// reconciliation the worker/admin path uses in production
// (@gateway/ledger's runLedgerReconciliation, SPEC section 21) against
// whatever DATABASE_URL points at, plus a duplicate-credit check on
// token_transfers' UNIQUE(network, tx_hash, transfer_index) constraint -
// this is not a bespoke drill-only check, it is the real reconciliation
// path re-run against the post-restore database.
//
// Usage: DATABASE_URL=postgresql://... node scripts/kubernetes/dr-verify.cjs
const path = require('node:path');

const { PrismaClient } = require(path.join(__dirname, '../../packages/database/dist/client.js'));
const { runLedgerReconciliation } = require(path.join(__dirname, '../../packages/ledger/dist/reconciliation.js'));

async function main() {
  const db = new PrismaClient();
  try {
    const merchants = await db.merchant.findMany({ select: { id: true, name: true, slug: true } });
    const ledgerAccounts = await db.ledgerAccount.count();
    const invoices = await db.invoice.count().catch(() => null);
    const chainCursors = await db.chainCursor.findMany();
    const webhookDeliveries = await db.webhookDelivery.groupBy({ by: ['status'], _count: true });

    console.log(`merchants: ${merchants.length}`);
    for (const m of merchants) console.log(`  - ${m.id} ${m.name} (${m.slug})`);
    console.log(`ledger accounts: ${ledgerAccounts}`);
    if (invoices !== null) console.log(`payment invoices: ${invoices}`);
    console.log('chain_cursors:');
    for (const c of chainCursors) {
      console.log(
        `  - ${c.network} lastProcessedBlock=${c.lastProcessedBlock} leaseOwner=${c.leaseOwner ?? 'none'} leaseExpiresAt=${c.leaseExpiresAt ?? 'none'}`,
      );
    }
    console.log('webhook_deliveries by status:', JSON.stringify(webhookDeliveries));

    // Duplicate-credit check: the DB-level UNIQUE(network, tx_hash,
    // transfer_index) constraint is what actually prevents this, but this
    // query proves it held - a raw GROUP BY/HAVING over the live data, not
    // just trusting the schema definition.
    const dupes = await db.$queryRawUnsafe(
      `SELECT network, tx_hash, transfer_index, count(*) AS n
       FROM token_transfers GROUP BY network, tx_hash, transfer_index HAVING count(*) > 1`,
    );
    console.log(`token_transfers duplicate (network, tx_hash, transfer_index) groups: ${dupes.length}`);

    const summary = await runLedgerReconciliation(db);
    console.log('ledger reconciliation:', JSON.stringify(summary));

    const ok = summary.status === 'CLEAN' && dupes.length === 0;
    console.log(ok ? 'VERIFY: PASS' : 'VERIFY: FAIL');
    process.exitCode = ok ? 0 : 1;
  } finally {
    await db.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
