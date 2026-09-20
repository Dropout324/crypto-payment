import { requirePlatformRole, serverFetch } from '@/lib/session';
import type { ListAdminRefundsResponse } from '@/lib/types';
import { DataTable } from '@/components/DataTable';
import { StatusBadge } from '@/components/StatusBadge';
import { RefundDecisionButtons } from '@/components/admin/RefundDecisionButtons';

export default async function AdminRefundsPage() {
  const session = await requirePlatformRole();
  // Mirrors PlatformPermission.REFUNDS_DECIDE in apps/api/src/auth/permissions.ts (ADMIN only).
  const canDecide = session.user.platform_role === 'ADMIN';
  const { refunds } = await serverFetch<ListAdminRefundsResponse>('/v1/admin/refunds');

  return (
    <div>
      <h1 className="mb-6 text-xl font-semibold">Refunds</h1>
      <DataTable
        rows={refunds}
        empty="No refunds."
        columns={[
          { header: 'Invoice', cell: (r) => r.invoice_id.slice(0, 10) + '…' },
          { header: 'Amount', cell: (r) => `${r.amount} ${r.asset} (${r.network})` },
          { header: 'Destination', cell: (r) => <span className="font-mono text-xs">{r.destination_address.slice(0, 12)}…</span> },
          { header: 'Status', cell: (r) => <StatusBadge status={r.status} /> },
          { header: 'Compliance', cell: (r) => <StatusBadge status={r.compliance_status} /> },
          { header: 'Reason', cell: (r) => r.reason ?? '—' },
          { header: 'Requested by', cell: (r) => r.requested_by },
          { header: 'Created', cell: (r) => new Date(r.created_at).toLocaleString() },
          {
            header: 'Actions',
            cell: (r) => (canDecide ? <RefundDecisionButtons id={r.id} status={r.status} /> : '—'),
          },
        ]}
      />
    </div>
  );
}
