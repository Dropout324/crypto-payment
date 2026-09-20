import { monotonicFactory, ulid as randomUlid } from 'ulid';

/**
 * ULIDs, not UUIDv4: they are lexicographically sortable by creation time,
 * which keeps B-tree index inserts append-only on high-write tables such as
 * blockchain_transactions and ledger_entries.
 *
 * The monotonic factory guarantees strictly increasing IDs within the same
 * millisecond, so two invoices created in the same tick still order correctly.
 */
const nextUlid = monotonicFactory();

export const ID_PREFIXES = {
  user: 'usr',
  merchant: 'mch',
  merchantMember: 'mm',
  apiKey: 'ak',
  webhookEndpoint: 'whe',
  invoice: 'inv',
  paymentAddress: 'addr',
  blockchainTransaction: 'btx',
  tokenTransfer: 'ttr',
  paymentEvent: 'pev',
  webhookEvent: 'evt',
  webhookDelivery: 'whd',
  wallet: 'wlt',
  walletAccount: 'wac',
  settlement: 'stl',
  refund: 'rfd',
  ledgerTransaction: 'ltx',
  ledgerEntry: 'lent',
  ledgerAccount: 'lacc',
  auditLog: 'aud',
  idempotency: 'idem',
  reconciliation: 'rec',
  session: 'ses',
  signingRequest: 'sgr',
  signingSpendEntry: 'sse',
} as const;

export type IdKind = keyof typeof ID_PREFIXES;

/** `inv_01J8Z3Q...` — prefix makes IDs self-describing in logs and support tickets. */
export function newId(kind: IdKind): string {
  return `${ID_PREFIXES[kind]}_${nextUlid()}`;
}

/** Non-monotonic variant for cases where ordering must not leak timing. */
export function newRandomId(kind: IdKind): string {
  return `${ID_PREFIXES[kind]}_${randomUlid()}`;
}

export function isId(kind: IdKind, value: string): boolean {
  const prefix = `${ID_PREFIXES[kind]}_`;
  if (!value.startsWith(prefix)) return false;
  const body = value.slice(prefix.length);
  return /^[0-9A-HJKMNP-TV-Z]{26}$/.test(body);
}

export function parseIdKind(value: string): IdKind | null {
  const prefix = value.split('_')[0];
  if (!prefix) return null;
  const entry = Object.entries(ID_PREFIXES).find(([, p]) => p === prefix);
  return entry ? (entry[0] as IdKind) : null;
}
