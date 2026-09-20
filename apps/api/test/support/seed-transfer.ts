import { newId } from '@gateway/shared';
import type { DatabaseClient } from '@gateway/database';

export interface SeededTransfer {
  invoiceId: string;
  transactionId: string;
  transferId: string;
  txHash: string;
}

/**
 * Creates a real, credited invoice + blockchain transaction + token transfer
 * for one merchant - the minimum a transaction-lookup or transactions-list
 * test needs, and the FK prerequisite `postPaymentCredit` requires (both
 * `invoiceId` and `tokenTransferId` reference real rows).
 */
export async function seedCreditedTransfer(
  db: DatabaseClient,
  params: {
    merchantId: string;
    network?: string;
    asset?: string;
    decimals?: number;
    amountUnits?: bigint;
    txHash?: string;
  },
): Promise<SeededTransfer> {
  const network = params.network ?? 'ETHEREUM';
  const asset = params.asset ?? 'USDT';
  const decimals = params.decimals ?? 6;
  const amountUnits = params.amountUnits ?? 100_000_000n;
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const txHash = params.txHash ?? `0x${suffix.padEnd(64, '0').replace(/[^0-9a-f]/g, '1').slice(0, 64)}`;

  const invoiceId = newId('invoice');
  await db.invoice.create({
    data: {
      id: invoiceId,
      merchantId: params.merchantId,
      orderId: `ORDER-${suffix}`,
      requestedCurrency: 'USD',
      requestedDecimals: 2,
      requestedAmount: '100',
      paymentAsset: asset,
      paymentDecimals: decimals,
      network: network as never,
      cryptoAmount: amountUnits.toString(),
      underpaymentPolicy: 'MANUAL_REVIEW',
      overpaymentPolicy: 'MANUAL_REVIEW',
      underpaymentToleranceBps: 0,
      overpaymentToleranceBps: 0,
      requiredConfirmations: 12,
      status: 'PAID',
      receivedAmount: amountUnits.toString(),
      confirmedAmount: amountUnits.toString(),
      expiresAt: new Date(Date.now() + 900_000),
    },
  });

  const transactionId = newId('blockchainTransaction');
  await db.blockchainTransaction.create({
    data: { id: transactionId, network: network as never, txHash, status: 'CONFIRMED', confirmations: 20 },
  });

  const transferId = newId('tokenTransfer');
  await db.tokenTransfer.create({
    data: {
      id: transferId,
      transactionId,
      network: network as never,
      txHash,
      transferIndex: 0,
      assetSymbol: asset,
      assetDecimals: decimals,
      amount: amountUnits.toString(),
      toAddress: '0xabc',
      toAddressNormalized: '0xabc',
      invoiceId,
      matchStatus: 'CREDITED',
      creditedAt: new Date(),
    },
  });

  return { invoiceId, transactionId, transferId, txHash };
}
