'use client';

import { useEffect, useState } from 'react';
import QRCode from 'react-qr-code';
import { apiGet } from '@/lib/api-client';
import { ApiError } from '@/lib/api';
import type { PublicInvoiceResponse } from '@/lib/types';
import { StatusBadge } from './StatusBadge';

const TERMINAL_STATUSES = new Set(['PAID', 'UNDERPAID', 'OVERPAID', 'EXPIRED', 'CANCELLED', 'FAILED', 'REFUNDED']);
const POLL_INTERVAL_MS = 5000;

/** Polls the public invoice endpoint while the payer is on the page, so confirmations update without a manual refresh. */
export function PaymentStatus({ invoiceId, initial }: { invoiceId: string; initial: PublicInvoiceResponse }) {
  const [invoice, setInvoice] = useState(initial);
  const [gone, setGone] = useState(false);

  useEffect(() => {
    if (TERMINAL_STATUSES.has(invoice.status)) return;

    const timer = setInterval(async () => {
      try {
        const next = await apiGet<PublicInvoiceResponse>(`/v1/public/invoices/${invoiceId}`);
        setInvoice(next);
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) setGone(true);
      }
    }, POLL_INTERVAL_MS);

    return () => clearInterval(timer);
  }, [invoiceId, invoice.status]);

  if (gone) {
    return <p className="text-sm text-zinc-400">This invoice is no longer available.</p>;
  }

  return (
    <div className="flex w-full max-w-sm flex-col gap-4 rounded-lg border border-zinc-800 p-6">
      <div className="flex items-center justify-between">
        <span className="text-sm text-zinc-400">Pay {invoice.merchant_name}</span>
        <StatusBadge status={invoice.status} />
      </div>

      <div>
        <div className="text-2xl font-semibold">
          {invoice.crypto_amount} {invoice.asset}
        </div>
        <div className="text-sm text-zinc-500">
          {invoice.amount} {invoice.currency} · {invoice.network}
        </div>
      </div>

      {invoice.payment_address && !TERMINAL_STATUSES.has(invoice.status) && (
        <div className="flex flex-col items-center gap-3">
          {/* A scannable BIP-21/EIP-681 URI (ADR 0018) when this asset/network
              supports one; falls back to the bare address so scanning is
              still available even when payment_uri is null (the payer just
              has to enter the amount themselves in that case). */}
          <div className="rounded-md bg-white p-3">
            <QRCode value={invoice.payment_uri ?? invoice.payment_address} size={160} />
          </div>
          <div className="w-full">
            <div className="text-xs text-zinc-500">Send to</div>
            <div className="break-all font-mono text-sm">{invoice.payment_address}</div>
          </div>
        </div>
      )}

      {Number(invoice.received_amount) > 0 && (
        <div className="text-sm text-zinc-400">
          Received: {invoice.received_amount} {invoice.asset} · Confirmations: {invoice.confirmation_count}/
          {invoice.required_confirmations}
        </div>
      )}

      {invoice.transaction_hash && (
        <div className="text-xs text-zinc-500">
          Tx: <span className="font-mono">{invoice.transaction_hash}</span>
        </div>
      )}

      <div className="text-xs text-zinc-500">
        {TERMINAL_STATUSES.has(invoice.status)
          ? invoice.status === 'PAID'
            ? 'Payment complete.'
            : `This invoice is ${invoice.status.toLowerCase()}.`
          : // A fixed locale/timezone, not the runtime default: the server
            // (Node) and the payer's browser otherwise pick different
            // locales and render different strings, which Next.js's SSR
            // hydration check flags as an error - not just a cosmetic one,
            // since the mismatch throws away this component's state on the
            // client, e.g. the amount-received line above.
            `Expires ${new Date(invoice.expires_at).toLocaleString('en-US', { timeZone: 'UTC', dateStyle: 'medium', timeStyle: 'short' })} UTC`}
      </div>
    </div>
  );
}
