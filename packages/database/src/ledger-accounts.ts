import type { LedgerAccountType, Network } from '@prisma/client';

/**
 * CHART OF ACCOUNTS.
 *
 * Account codes are deterministic strings, so any process can derive the code
 * it needs without a lookup, and two workers posting the same movement always
 * hit the same account.
 *
 * Shape: `<kind>:<scope...>:<network>:<asset>`
 * An account holds exactly one asset on exactly one network; cross-asset
 * postings are therefore impossible by construction.
 */

export const LedgerAccountKind = {
  /**
   * Crypto the gateway itself controls (custodial mode). Debit increases it.
   */
  GATEWAY_HOLDINGS: 'gateway_holdings',
  /**
   * Crypto sitting in a merchant's own wallet (merchant-controlled mode). We
   * track it so the books balance even though we never hold the keys.
   */
  MERCHANT_HOLDINGS: 'merchant_holdings',
  /**
   * What the gateway owes a merchant. Credit increases it.
   */
  MERCHANT_PAYABLE: 'merchant_payable',
  /**
   * Counterparty account for funds entering the system from outside. Every
   * incoming payment credits it, which is what keeps the entry balanced
   * without inventing money.
   */
  CUSTOMER_INFLOW: 'customer_inflow',
  /**
   * Counterparty for funds leaving to a customer during a refund.
   */
  CUSTOMER_REFUND: 'customer_refund',
  /** Gateway commission earned. */
  FEE_REVENUE: 'fee_revenue',
  /** On-chain fees the gateway paid. */
  NETWORK_FEE_EXPENSE: 'network_fee_expense',
  /**
   * Holding account for funds that arrived but must not be credited yet:
   * late payments, unsupported assets, compliance holds. Money is never
   * unaccounted for, it is merely parked here.
   */
  SUSPENSE: 'suspense',
} as const;

export type LedgerAccountKindValue =
  (typeof LedgerAccountKind)[keyof typeof LedgerAccountKind];

const ACCOUNT_TYPES: Record<LedgerAccountKindValue, LedgerAccountType> = {
  [LedgerAccountKind.GATEWAY_HOLDINGS]: 'ASSET',
  [LedgerAccountKind.MERCHANT_HOLDINGS]: 'ASSET',
  [LedgerAccountKind.MERCHANT_PAYABLE]: 'LIABILITY',
  [LedgerAccountKind.CUSTOMER_INFLOW]: 'EQUITY',
  [LedgerAccountKind.CUSTOMER_REFUND]: 'EQUITY',
  [LedgerAccountKind.FEE_REVENUE]: 'REVENUE',
  [LedgerAccountKind.NETWORK_FEE_EXPENSE]: 'EXPENSE',
  [LedgerAccountKind.SUSPENSE]: 'LIABILITY',
};

export function ledgerAccountType(kind: LedgerAccountKindValue): LedgerAccountType {
  return ACCOUNT_TYPES[kind];
}

/**
 * Whether a DEBIT increases this account's balance. Assets and expenses
 * increase on the debit side; liabilities, equity and revenue on the credit
 * side. Balance computation depends on getting this right.
 */
export function debitIncreases(type: LedgerAccountType): boolean {
  return type === 'ASSET' || type === 'EXPENSE';
}

export interface AccountCodeParams {
  kind: LedgerAccountKindValue;
  network: Network;
  assetSymbol: string;
  /** Required for merchant-scoped kinds, omitted for platform-wide ones. */
  merchantId?: string;
}

const MERCHANT_SCOPED: ReadonlySet<LedgerAccountKindValue> = new Set([
  LedgerAccountKind.MERCHANT_HOLDINGS,
  LedgerAccountKind.MERCHANT_PAYABLE,
]);

export function isMerchantScoped(kind: LedgerAccountKindValue): boolean {
  return MERCHANT_SCOPED.has(kind);
}

export function ledgerAccountCode(params: AccountCodeParams): string {
  const { kind, network, assetSymbol, merchantId } = params;

  if (isMerchantScoped(kind)) {
    if (!merchantId) {
      throw new Error(`ledger account kind ${kind} requires a merchantId`);
    }
    return `${kind}:${merchantId}:${network}:${assetSymbol}`;
  }

  if (merchantId) {
    throw new Error(`ledger account kind ${kind} is platform-wide and takes no merchantId`);
  }

  return `${kind}:${network}:${assetSymbol}`;
}

export interface ParsedAccountCode {
  kind: LedgerAccountKindValue;
  merchantId: string | null;
  network: string;
  assetSymbol: string;
}

export function parseLedgerAccountCode(code: string): ParsedAccountCode {
  const parts = code.split(':');
  const kind = parts[0] as LedgerAccountKindValue | undefined;

  if (!kind || !(kind in ACCOUNT_TYPES)) {
    throw new Error(`unrecognised ledger account code: ${code}`);
  }

  if (isMerchantScoped(kind)) {
    if (parts.length !== 4) throw new Error(`malformed merchant-scoped account code: ${code}`);
    return {
      kind,
      merchantId: parts[1] as string,
      network: parts[2] as string,
      assetSymbol: parts[3] as string,
    };
  }

  if (parts.length !== 3) throw new Error(`malformed account code: ${code}`);
  return {
    kind,
    merchantId: null,
    network: parts[1] as string,
    assetSymbol: parts[2] as string,
  };
}

/** Human-readable label for dashboards. */
export function ledgerAccountName(params: AccountCodeParams): string {
  const scope = params.merchantId ? ` (${params.merchantId})` : '';
  const labels: Record<LedgerAccountKindValue, string> = {
    [LedgerAccountKind.GATEWAY_HOLDINGS]: 'Gateway holdings',
    [LedgerAccountKind.MERCHANT_HOLDINGS]: 'Merchant wallet holdings',
    [LedgerAccountKind.MERCHANT_PAYABLE]: 'Merchant payable',
    [LedgerAccountKind.CUSTOMER_INFLOW]: 'Customer inflow',
    [LedgerAccountKind.CUSTOMER_REFUND]: 'Customer refund',
    [LedgerAccountKind.FEE_REVENUE]: 'Gateway fee revenue',
    [LedgerAccountKind.NETWORK_FEE_EXPENSE]: 'Network fee expense',
    [LedgerAccountKind.SUSPENSE]: 'Suspense (uncredited receipts)',
  };
  return `${labels[params.kind]}${scope} - ${params.assetSymbol} on ${params.network}`;
}
