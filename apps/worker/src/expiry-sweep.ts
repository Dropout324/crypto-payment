import type { DatabaseClient, TransactionClient } from '@gateway/database';
import { Prisma, runInTransaction } from '@gateway/database';
import { InvoiceStatus, type InvoiceStatusValue, newId } from '@gateway/shared';
import { TransitionActor, assertTransition, evaluateExpiry, isActorAllowed, webhookEventForStatus } from '@gateway/payments';

/**
 * Proactive expiry sweep (README "Known limitation": expiry was lazy-only,
 * checked on read; this is the "sweep worker...planned for apps/worker" it
 * referred to).
 *
 * Only PENDING and UNDERPAID are SYSTEM-transitionable to EXPIRED - every
 * other status either has no EXPIRED edge, or (RECONCILIATION_REQUIRED) has
 * one reserved for an admin resolving a discrepancy, never automation. Scope
 * the query to exactly those two so this never attempts a transition
 * `assertTransition` would reject.
 */
const SWEEPABLE_STATUSES: InvoiceStatusValue[] = [InvoiceStatus.PENDING, InvoiceStatus.UNDERPAID];

export interface ExpirySweepResult {
  candidates: number;
  expired: number;
}

export async function sweepExpiredInvoices(db: DatabaseClient, batchSize = 200, now: Date = new Date()): Promise<ExpirySweepResult> {
  // Oldest deadline first. Without an ORDER BY, `take` returns whatever subset
  // Postgres happens to produce, so under a backlog larger than `batchSize`
  // some invoices could be skipped tick after tick while newer ones expire -
  // an invoice's time spent past its deadline would be unbounded. Served by
  // the `(status, expires_at)` index.
  const candidates = await db.invoice.findMany({
    where: { status: { in: SWEEPABLE_STATUSES }, expiresAt: { lte: now } },
    select: { id: true },
    orderBy: { expiresAt: 'asc' },
    take: batchSize,
  });

  let expired = 0;
  for (const { id } of candidates) {
    const didExpire = await runInTransaction(db, (tx) => expireOne(tx, id, now));
    if (didExpire) expired += 1;
  }

  return { candidates: candidates.length, expired };
}

async function expireOne(tx: TransactionClient, invoiceId: string, now: Date): Promise<boolean> {
  const invoice = await tx.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
  const status = invoice.status as InvoiceStatusValue;

  // Re-check inside the transaction: another sweep tick, or a merchant's own
  // GET (still lazily expiring on read too), may have already resolved this
  // invoice since the outer query ran.
  if (!isActorAllowed(status, InvoiceStatus.EXPIRED, TransitionActor.SYSTEM) || !evaluateExpiry(invoice.expiresAt, now).expired) {
    return false;
  }

  assertTransition(status, InvoiceStatus.EXPIRED, TransitionActor.SYSTEM);
  await tx.invoice.update({
    where: { id: invoiceId },
    data: { status: InvoiceStatus.EXPIRED, expiredAt: now, version: { increment: 1 } },
  });

  const nextSequence = (await tx.paymentEvent.count({ where: { invoiceId } })) + 1;
  await tx.paymentEvent.create({
    data: {
      id: newId('paymentEvent'),
      invoiceId,
      type: 'payment.expired',
      fromStatus: status,
      toStatus: InvoiceStatus.EXPIRED,
      sequence: nextSequence,
      actor: 'system:worker',
    },
  });

  const eventType = webhookEventForStatus(InvoiceStatus.EXPIRED);
  if (eventType) {
    await tx.webhookEvent.upsert({
      where: { idempotencyKey: `${eventType}:${invoiceId}` },
      update: {},
      create: {
        id: newId('webhookEvent'),
        merchantId: invoice.merchantId,
        invoiceId,
        type: eventType,
        idempotencyKey: `${eventType}:${invoiceId}`,
        payload: { event: eventType, data: { invoice_id: invoiceId, order_id: invoice.orderId } } as Prisma.InputJsonValue,
      },
    });
  }

  return true;
}
