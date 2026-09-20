import { Money, newId } from '@gateway/shared';
import {
  LedgerAccountKind,
  Prisma,
  type TransactionClient,
  ledgerAccountCode,
  ledgerAccountName,
  ledgerAccountType,
  unitsToDecimal,
} from '@gateway/database';
import type { Network } from '@gateway/database';

/**
 * Double-entry posting (SPEC section 20).
 *
 * Every function here writes a BALANCED set of `ledger_entries` under one
 * `ledger_transaction`. The database enforces the balance and the
 * idempotency key at commit (ADR 0001's migration); this module's job is to
 * compute the right legs and never bypass that guarantee - there is no path
 * here that writes a single-legged entry.
 *
 * Money model for a crediting payment (Mode B, merchant-controlled wallet):
 *
 *   DEBIT  merchant_holdings   gross   (value now sitting in the merchant's
 *                                       own wallet, which we monitor but do
 *                                       not custody)
 *   CREDIT merchant_payable    net     (what the ledger recognises as
 *                                       attributable to the merchant)
 *   CREDIT fee_revenue         fee     (the gateway's commission)
 *
 *   gross = net + fee, so the entry balances by construction.
 */

export interface AccountRef {
  network: Network;
  assetSymbol: string;
  assetDecimals: number;
}

/** Idempotently finds or creates a ledger account for the given (kind, scope, asset). */
async function ensureAccount(
  tx: TransactionClient,
  kind: (typeof LedgerAccountKind)[keyof typeof LedgerAccountKind],
  ref: AccountRef,
  merchantId?: string,
): Promise<string> {
  const code = ledgerAccountCode({ kind, network: ref.network, assetSymbol: ref.assetSymbol, ...(merchantId ? { merchantId } : {}) });

  const existing = await tx.ledgerAccount.findUnique({ where: { code } });
  if (existing) return existing.id;

  const created = await tx.ledgerAccount.create({
    data: {
      id: newId('ledgerAccount'),
      code,
      name: ledgerAccountName({ kind, network: ref.network, assetSymbol: ref.assetSymbol, ...(merchantId ? { merchantId } : {}) }),
      type: ledgerAccountType(kind),
      assetSymbol: ref.assetSymbol,
      assetDecimals: ref.assetDecimals,
      network: ref.network,
      ...(merchantId ? { merchantId } : {}),
    },
  });
  return created.id;
}

export class LedgerPostingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LedgerPostingError';
  }
}

export interface PostPaymentCreditParams {
  merchantId: string;
  invoiceId: string;
  tokenTransferId: string;
  network: Network;
  assetSymbol: string;
  assetDecimals: number;
  /** Full amount actually received, in smallest units. */
  grossAmount: Money;
  /** Gateway commission, in basis points of the gross amount. */
  feeBps: number;
  /** Uniquely identifies this business event, e.g. `credit:ETHEREUM:0xabc...:0`. */
  idempotencyKey: string;
}

export interface PostingResult {
  ledgerTransactionId: string;
  /** True when this call found and returned an existing posting instead of creating one. */
  alreadyPosted: boolean;
  grossAmount: Money;
  feeAmount: Money;
  netAmount: Money;
}

export async function postPaymentCredit(tx: TransactionClient, params: PostPaymentCreditParams): Promise<PostingResult> {
  if (!params.grossAmount.isPositive) {
    throw new LedgerPostingError('gross amount must be positive');
  }
  if (!Number.isInteger(params.feeBps) || params.feeBps < 0 || params.feeBps > 10_000) {
    throw new LedgerPostingError(`feeBps must be an integer in [0, 10000], got ${params.feeBps}`);
  }

  const existing = await tx.ledgerTransaction.findUnique({ where: { idempotencyKey: params.idempotencyKey } });
  if (existing) {
    // Idempotent replay: recompute the split for the response, but do not
    // touch the database. The stored entries are the ones that count.
    const feeAmount = params.grossAmount.percentageBps(params.feeBps, 'floor');
    return {
      ledgerTransactionId: existing.id,
      alreadyPosted: true,
      grossAmount: params.grossAmount,
      feeAmount,
      netAmount: params.grossAmount.subtract(feeAmount),
    };
  }

  // Fee rounds down: any sub-unit remainder from the split favours the
  // merchant, never the gateway's own revenue line.
  const feeAmount = params.grossAmount.percentageBps(params.feeBps, 'floor');
  const netAmount = params.grossAmount.subtract(feeAmount);

  const ref: AccountRef = { network: params.network, assetSymbol: params.assetSymbol, assetDecimals: params.assetDecimals };
  const holdingsAccountId = await ensureAccount(tx, LedgerAccountKind.MERCHANT_HOLDINGS, ref, params.merchantId);
  const payableAccountId = await ensureAccount(tx, LedgerAccountKind.MERCHANT_PAYABLE, ref, params.merchantId);

  const ledgerTransactionId = newId('ledgerTransaction');

  await tx.ledgerTransaction.create({
    data: {
      id: ledgerTransactionId,
      type: 'payment.credit',
      description: `Payment credited for invoice ${params.invoiceId}`,
      invoiceId: params.invoiceId,
      tokenTransferId: params.tokenTransferId,
      idempotencyKey: params.idempotencyKey,
    },
  });

  const entries: Prisma.LedgerEntryCreateManyInput[] = [
    {
      id: newId('ledgerEntry'),
      ledgerTransactionId,
      accountId: holdingsAccountId,
      direction: 'DEBIT',
      amount: unitsToDecimal(params.grossAmount.units),
      assetSymbol: params.assetSymbol,
      assetDecimals: params.assetDecimals,
      metadata: { invoiceId: params.invoiceId, tokenTransferId: params.tokenTransferId },
    },
    {
      id: newId('ledgerEntry'),
      ledgerTransactionId,
      accountId: payableAccountId,
      direction: 'CREDIT',
      amount: unitsToDecimal(netAmount.units),
      assetSymbol: params.assetSymbol,
      assetDecimals: params.assetDecimals,
      metadata: { invoiceId: params.invoiceId, tokenTransferId: params.tokenTransferId },
    },
  ];

  // A zero fee (feeBps = 0, or a gross amount too small for the fee to round
  // to a non-zero unit) omits the fee leg entirely rather than posting a
  // zero-amount entry - the CHECK constraint on ledger_entries requires a
  // strictly positive amount, and a two-leg gross==net posting is still
  // perfectly balanced.
  if (feeAmount.isPositive) {
    const feeAccountId = await ensureAccount(tx, LedgerAccountKind.FEE_REVENUE, ref);
    entries.push({
      id: newId('ledgerEntry'),
      ledgerTransactionId,
      accountId: feeAccountId,
      direction: 'CREDIT',
      amount: unitsToDecimal(feeAmount.units),
      assetSymbol: params.assetSymbol,
      assetDecimals: params.assetDecimals,
      metadata: { invoiceId: params.invoiceId, tokenTransferId: params.tokenTransferId },
    });
  }

  await tx.ledgerEntry.createMany({ data: entries });

  return { ledgerTransactionId, alreadyPosted: false, grossAmount: params.grossAmount, feeAmount, netAmount };
}

export { ensureAccount };
