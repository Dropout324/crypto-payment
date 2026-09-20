import { requireSession } from '@/lib/session';
import { resolveCurrentMerchantId, merchantFetch } from '@/lib/merchant';
import type { ListTransactionsResponse } from '@/lib/types';
import { DataTable } from '@/components/DataTable';
import { StatusBadge } from '@/components/StatusBadge';

export default async function TransactionsPage() {
  const session = await requireSession();
  const merchantId = await resolveCurrentMerchantId(session.memberships);
  if (!merchantId) return null;

  const { transactions } = await merchantFetch<ListTransactionsResponse>('/v1/merchant/me/transactions', merchantId);

  return (
    <div>
      <h1 className="mb-6 text-xl font-semibold">Transactions</h1>
      <DataTable
        rows={transactions}
        empty="No on-chain transfers detected yet."
        columns={[
          { header: 'Tx hash', cell: (r) => <span className="font-mono text-xs">{r.tx_hash.slice(0, 14)}…</span> },
          { header: 'Network', cell: (r) => r.network },
          { header: 'Amount', cell: (r) => `${r.amount} ${r.asset}` },
          { header: 'Match', cell: (r) => <StatusBadge status={r.match_status} /> },
          { header: 'Confirmations', cell: (r) => r.confirmations },
          { header: 'Invoice', cell: (r) => r.invoice_id ?? '—' },
          { header: 'Detected', cell: (r) => new Date(r.detected_at).toLocaleString() },
        ]}
      />
    </div>
  );
}
