import { requirePlatformRole, serverFetch } from '@/lib/session';
import type { ListAdminSettlementsResponse } from '@/lib/types';
import { DataTable } from '@/components/DataTable';
import { StatusBadge } from '@/components/StatusBadge';

export default async function AdminSettlementsPage() {
  await requirePlatformRole();
  const { settlements } = await serverFetch<ListAdminSettlementsResponse>('/v1/admin/settlements');

  return (
    <div>
      <h1 className="mb-6 text-xl font-semibold">Settlements</h1>
      <DataTable
        rows={settlements}
        empty="No settlements."
        columns={[
          { header: 'Merchant', cell: (r) => r.merchant_id.slice(0, 10) + '…' },
          { header: 'Network', cell: (r) => r.network },
          { header: 'Gross', cell: (r) => `${r.gross_amount} ${r.asset}` },
          { header: 'Fee', cell: (r) => r.fee_amount },
          { header: 'Network fee', cell: (r) => r.network_fee },
          { header: 'Net', cell: (r) => r.net_amount },
          { header: 'Status', cell: (r) => <StatusBadge status={r.status} /> },
          { header: 'Tx', cell: (r) => (r.tx_hash ? <span className="font-mono text-xs">{r.tx_hash.slice(0, 10)}…</span> : '—') },
          { header: 'Created', cell: (r) => new Date(r.created_at).toLocaleString() },
        ]}
      />
    </div>
  );
}
