import { Money, buildPaymentUri, type NetworkValue } from '@gateway/shared';
import { decimalToUnits } from '@gateway/database';
import type { Invoice } from '@gateway/database';

/** SPEC section 16/6 response shape. Field names are the public API contract. */
export interface InvoiceResponse {
  id: string;
  order_id: string;
  external_reference: string | null;
  status: string;
  amount: string;
  currency: string;
  asset: string;
  network: string;
  crypto_amount: string;
  received_amount: string;
  confirmed_amount: string;
  payment_address: string | null;
  /** A scannable BIP-21/EIP-681 URI for `payment_address` (ADR 0018) - null until an address is assigned, or for a network/asset this doesn't cover yet. */
  payment_uri: string | null;
  confirmation_count: number;
  required_confirmations: number;
  transaction_hash: string | null;
  callback_url: string | null;
  metadata: Record<string, unknown>;
  expires_at: string;
  detected_at: string | null;
  paid_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface InvoiceStatusResponse {
  id: string;
  status: string;
  confirmation_count: number;
  required_confirmations: number;
  received_amount: string;
  crypto_amount: string;
  expires_at: string;
  transaction_hash: string | null;
}

export function toInvoiceResponse(
  invoice: Invoice,
  extras: { paymentAddress: string | null; transactionHash: string | null },
): InvoiceResponse {
  const requested = Money.fromUnits(decimalToUnits(invoice.requestedAmount), invoice.requestedCurrency, invoice.requestedDecimals);
  const crypto = Money.fromUnits(decimalToUnits(invoice.cryptoAmount), invoice.paymentAsset, invoice.paymentDecimals);
  const received = Money.fromUnits(decimalToUnits(invoice.receivedAmount), invoice.paymentAsset, invoice.paymentDecimals);
  const confirmed = Money.fromUnits(decimalToUnits(invoice.confirmedAmount), invoice.paymentAsset, invoice.paymentDecimals);

  const paymentUri = extras.paymentAddress
    ? buildPaymentUri(
        invoice.network as NetworkValue,
        invoice.paymentAsset,
        extras.paymentAddress,
        crypto.toDecimalString(),
      )
    : null;

  return {
    id: invoice.id,
    order_id: invoice.orderId,
    external_reference: invoice.externalReference,
    status: invoice.status,
    amount: requested.toDecimalString(),
    currency: invoice.requestedCurrency,
    asset: invoice.paymentAsset,
    network: invoice.network,
    crypto_amount: crypto.toDecimalString(),
    received_amount: received.toDecimalString(),
    confirmed_amount: confirmed.toDecimalString(),
    payment_address: extras.paymentAddress,
    payment_uri: paymentUri,
    confirmation_count: invoice.confirmationCount,
    required_confirmations: invoice.requiredConfirmations,
    transaction_hash: extras.transactionHash,
    callback_url: invoice.callbackUrl,
    metadata: invoice.metadata as Record<string, unknown>,
    expires_at: invoice.expiresAt.toISOString(),
    detected_at: invoice.detectedAt?.toISOString() ?? null,
    paid_at: invoice.paidAt?.toISOString() ?? null,
    created_at: invoice.createdAt.toISOString(),
    updated_at: invoice.updatedAt.toISOString(),
  };
}

/**
 * What an unauthenticated payer may see on the hosted payment page - a
 * strict subset of `InvoiceResponse`. Deliberately excludes
 * `external_reference`, `callback_url` and `metadata`: those are the
 * merchant's own integration details, never meant for the customer's
 * browser, even though the invoice `id` itself (a 26-char ULID, 80 bits of
 * randomness) is already unguessable enough to serve as the page's access
 * token - the same trust model Stripe Checkout and Coinbase Commerce use for
 * their hosted session/charge ids.
 */
export interface PublicInvoiceResponse {
  id: string;
  order_id: string;
  status: string;
  merchant_name: string;
  amount: string;
  currency: string;
  asset: string;
  network: string;
  crypto_amount: string;
  received_amount: string;
  confirmed_amount: string;
  payment_address: string | null;
  payment_uri: string | null;
  confirmation_count: number;
  required_confirmations: number;
  transaction_hash: string | null;
  expires_at: string;
  paid_at: string | null;
}

export function toPublicInvoiceResponse(
  invoice: Invoice,
  extras: { paymentAddress: string | null; transactionHash: string | null; merchantName: string },
): PublicInvoiceResponse {
  const full = toInvoiceResponse(invoice, extras);
  return {
    id: full.id,
    order_id: full.order_id,
    status: full.status,
    merchant_name: extras.merchantName,
    amount: full.amount,
    currency: full.currency,
    asset: full.asset,
    network: full.network,
    crypto_amount: full.crypto_amount,
    received_amount: full.received_amount,
    confirmed_amount: full.confirmed_amount,
    payment_address: full.payment_address,
    payment_uri: full.payment_uri,
    confirmation_count: full.confirmation_count,
    required_confirmations: full.required_confirmations,
    transaction_hash: full.transaction_hash,
    expires_at: full.expires_at,
    paid_at: full.paid_at,
  };
}

export function toInvoiceStatusResponse(
  invoice: Invoice,
  extras: { transactionHash: string | null },
): InvoiceStatusResponse {
  const crypto = Money.fromUnits(decimalToUnits(invoice.cryptoAmount), invoice.paymentAsset, invoice.paymentDecimals);
  const received = Money.fromUnits(decimalToUnits(invoice.receivedAmount), invoice.paymentAsset, invoice.paymentDecimals);

  return {
    id: invoice.id,
    status: invoice.status,
    confirmation_count: invoice.confirmationCount,
    required_confirmations: invoice.requiredConfirmations,
    received_amount: received.toDecimalString(),
    crypto_amount: crypto.toDecimalString(),
    expires_at: invoice.expiresAt.toISOString(),
    transaction_hash: extras.transactionHash,
  };
}
