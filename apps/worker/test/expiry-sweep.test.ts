import { createPrismaClient, type PrismaClient } from '@gateway/database';
import { newId } from '@gateway/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sweepExpiredInvoices } from '../src/index.js';

let db: PrismaClient;

const RUN = Date.now().toString(16);
let counter = 0;
function suffix(): string {
  counter += 1;
  return `${RUN}-${counter}`;
}

async function createMerchant(): Promise<string> {
  const s = suffix();
  const userId = newId('user');
  await db.user.create({ data: { id: userId, email: `worker-${s}@test.local`, passwordHash: 'x', platformRole: 'USER' } });
  const merchantId = newId('merchant');
  await db.merchant.create({ data: { id: merchantId, name: `Merchant ${s}`, slug: `merchant-${s}` } });
  await db.merchantMember.create({ data: { id: newId('user'), merchantId, userId, role: 'OWNER' } });
  return merchantId;
}

/**
 * `expiresAt` must stay strictly after `createdAt` (a DB CHECK constraint
 * enforces it), so an "already expired" fixture is created with a normal
 * future deadline and then back-dated to just 1ms after its own creation
 * time - already in the past by the time a test reads it. Mirrors the
 * same trick in apps/api/test/invoices.e2e.test.ts.
 */
async function createInvoice(
  merchantId: string,
  status: 'PENDING' | 'UNDERPAID' | 'DETECTED' | 'RECONCILIATION_REQUIRED',
  options: { expired: boolean },
): Promise<string> {
  const invoiceId = newId('invoice');
  const created = await db.invoice.create({
    data: {
      id: invoiceId,
      merchantId,
      orderId: `ORDER-${suffix()}`,
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
      requiredConfirmations: 3,
      status,
      expiresAt: new Date(Date.now() + 900_000),
    },
  });

  if (options.expired) {
    await db.invoice.update({ where: { id: invoiceId }, data: { expiresAt: new Date(created.createdAt.getTime() + 1) } });
  }

  return invoiceId;
}

beforeAll(async () => {
  db = createPrismaClient();
  await db.$connect();
});

afterAll(async () => {
  await db.$disconnect();
});

describe('sweepExpiredInvoices', () => {
  it('expires a PENDING invoice past its deadline, records the event, and emits a webhook event', async () => {
    const merchantId = await createMerchant();
    const invoiceId = await createInvoice(merchantId, 'PENDING', { expired: true });

    const result = await sweepExpiredInvoices(db);
    expect(result.expired).toBeGreaterThanOrEqual(1);

    const invoice = await db.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
    expect(invoice.status).toBe('EXPIRED');
    expect(invoice.expiredAt).not.toBeNull();

    const event = await db.paymentEvent.findFirstOrThrow({ where: { invoiceId, type: 'payment.expired' } });
    expect(event.fromStatus).toBe('PENDING');
    expect(event.toStatus).toBe('EXPIRED');

    const webhookEvent = await db.webhookEvent.findUniqueOrThrow({ where: { idempotencyKey: `payment.expired:${invoiceId}` } });
    expect(webhookEvent.invoiceId).toBe(invoiceId);
  });

  it('expires an UNDERPAID invoice past its deadline', async () => {
    const merchantId = await createMerchant();
    const invoiceId = await createInvoice(merchantId, 'UNDERPAID', { expired: true });

    await sweepExpiredInvoices(db);

    const invoice = await db.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
    expect(invoice.status).toBe('EXPIRED');
  });

  it('leaves a PENDING invoice untouched before its deadline', async () => {
    const merchantId = await createMerchant();
    const invoiceId = await createInvoice(merchantId, 'PENDING', { expired: false });

    await sweepExpiredInvoices(db);

    const invoice = await db.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
    expect(invoice.status).toBe('PENDING');
  });

  it('never touches DETECTED (a real transaction is in flight) even past the deadline', async () => {
    const merchantId = await createMerchant();
    const invoiceId = await createInvoice(merchantId, 'DETECTED', { expired: true });

    await sweepExpiredInvoices(db);

    const invoice = await db.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
    expect(invoice.status).toBe('DETECTED');
  });

  it('never touches RECONCILIATION_REQUIRED - its EXPIRED edge is admin-only, not automation', async () => {
    const merchantId = await createMerchant();
    const invoiceId = await createInvoice(merchantId, 'RECONCILIATION_REQUIRED', { expired: true });

    await expect(sweepExpiredInvoices(db)).resolves.toBeDefined();

    const invoice = await db.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
    expect(invoice.status).toBe('RECONCILIATION_REQUIRED');
  });

  it('is idempotent: sweeping an already-EXPIRED invoice again changes nothing', async () => {
    const merchantId = await createMerchant();
    const invoiceId = await createInvoice(merchantId, 'PENDING', { expired: true });

    await sweepExpiredInvoices(db);
    const firstEventCount = await db.paymentEvent.count({ where: { invoiceId } });
    expect(firstEventCount).toBeGreaterThanOrEqual(1);

    await sweepExpiredInvoices(db);
    const secondEventCount = await db.paymentEvent.count({ where: { invoiceId } });

    expect(secondEventCount).toBe(firstEventCount);
    const invoice = await db.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
    expect(invoice.status).toBe('EXPIRED');
  });
});
