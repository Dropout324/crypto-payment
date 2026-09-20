import { requireSession } from '@/lib/session';
import { resolveCurrentMerchantId, merchantFetch } from '@/lib/merchant';
import type { ListInvoicesResponse } from '@/lib/types';
import { DataTable } from '@/components/DataTable';
import { StatusBadge } from '@/components/StatusBadge';

export default async function InvoicesPage() {
  const session = await requireSession();
  const merchantId = await resolveCurrentMerchantId(session.memberships);
  if (!merchantId) return null;

  const { invoices } = await merchantFetch<ListInvoicesResponse>('/v1/merchant/me/invoices', merchantId);

  return (
    <div>
      <h1 className="mb-6 text-xl font-semibold">Invoices</h1>
      <DataTable
        rows={invoices}
        empty="No invoices yet."
        columns={[
          { header: 'Order', cell: (r) => r.order_id },
          { header: 'Status', cell: (r) => <StatusBadge status={r.status} /> },
          { header: 'Amount', cell: (r) => `${r.amount} ${r.currency}` },
          { header: 'Crypto', cell: (r) => `${r.crypto_amount} ${r.asset} (${r.network})` },
          { header: 'Confirmations', cell: (r) => `${r.confirmation_count}/${r.required_confirmations}` },
          { header: 'Created', cell: (r) => new Date(r.created_at).toLocaleString() },
        ]}
      />
    </div>
  );
}
