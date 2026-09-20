import { newId } from '@gateway/shared';
import type { DatabaseClient, Network } from '@gateway/database';

let counter = 0;
export function uniqueSuffix(): string {
  counter += 1;
  return `${Date.now().toString(16)}-${counter}`;
}

export async function createMerchant(
  db: DatabaseClient,
  overrides: Partial<{
    feeBps: number;
    underpaymentPolicy: 'REJECT' | 'ACCEPT_PARTIAL' | 'REQUEST_ADDITIONAL' | 'MANUAL_REVIEW';
    overpaymentPolicy: 'ACCEPT_FULL' | 'CREDIT_DIFFERENCE' | 'REFUND_DIFFERENCE' | 'MANUAL_REVIEW';
  }> = {},
): Promise<string> {
  const suffix = uniqueSuffix();
  const userId = newId('user');
  await db.user.create({ data: { id: userId, email: `monitor-${suffix}@test.local`, passwordHash: 'x', platformRole: 'USER' } });

  const merchantId = newId('merchant');
  await db.merchant.create({
    data: {
      id: merchantId,
      name: `Monitor Test Merchant ${suffix}`,
      slug: `monitor-${suffix}`,
      status: 'ACTIVE',
      feeBps: overrides.feeBps ?? 100,
      underpaymentPolicy: overrides.underpaymentPolicy ?? 'MANUAL_REVIEW',
      overpaymentPolicy: overrides.overpaymentPolicy ?? 'MANUAL_REVIEW',
      members: { create: { id: newId('merchantMember'), userId, role: 'OWNER' } },
    },
  });
  return merchantId;
}

export interface InvoiceFixtureOptions {
  merchantId: string;
  network: Network;
  asset: string;
  decimals: number;
  cryptoAmountUnits: bigint;
  requiredConfirmations?: number;
  underpaymentToleranceBps?: number;
  overpaymentToleranceBps?: number;
  expiresAt?: Date;
  address: string;
}

/** Creates an invoice already PENDING with a deposit address assigned - the state a real invoice would be in when the monitor starts watching it. */
export async function createPendingInvoice(db: DatabaseClient, opts: InvoiceFixtureOptions): Promise<{ invoiceId: string; addressId: string }> {
  const invoiceId = newId('invoice');
  await db.invoice.create({
    data: {
      id: invoiceId,
      merchantId: opts.merchantId,
      orderId: `ORDER-${uniqueSuffix()}`,
      requestedCurrency: 'USD',
      requestedDecimals: 2,
      requestedAmount: '100',
      paymentAsset: opts.asset,
      paymentDecimals: opts.decimals,
      network: opts.network,
      cryptoAmount: opts.cryptoAmountUnits.toString(),
      underpaymentPolicy: 'MANUAL_REVIEW',
      overpaymentPolicy: 'MANUAL_REVIEW',
      underpaymentToleranceBps: opts.underpaymentToleranceBps ?? 0,
      overpaymentToleranceBps: opts.overpaymentToleranceBps ?? 0,
      requiredConfirmations: opts.requiredConfirmations ?? 3,
      status: 'PENDING',
      expiresAt: opts.expiresAt ?? new Date(Date.now() + 900_000),
    },
  });

  const addressId = newId('paymentAddress');
  await db.paymentAddress.create({
    data: {
      id: addressId,
      merchantId: opts.merchantId,
      network: opts.network,
      address: opts.address,
      // Case-insensitive hex (EVM) is lowercased; a Bitcoin address (which
      // never starts with "0x") is case-sensitive in general (legacy
      // Base58Check) and kept exactly as given - see the matching comment on
      // `normalizeForTracking` in `src/scanner.ts`.
      addressNormalized: opts.address.startsWith('0x') ? opts.address.toLowerCase() : opts.address,
      assetSymbol: opts.asset,
      status: 'ASSIGNED',
      invoiceId,
      assignedAt: new Date(),
    },
  });

  return { invoiceId, addressId };
}
