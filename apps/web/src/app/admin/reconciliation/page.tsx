import { requirePlatformRole, serverFetch } from '@/lib/session';
import type { ListAdminDiscrepanciesResponse } from '@/lib/types';
import { DataTable } from '@/components/DataTable';
import { StatusBadge } from '@/components/StatusBadge';
import { ResolveDiscrepancyForm } from '@/components/admin/ResolveDiscrepancyForm';

export default async function AdminReconciliationPage() {
  const session = await requirePlatformRole();
  // Mirrors PlatformPermission.RECONCILIATION_RESOLVE in apps/api/src/auth/permissions.ts (ADMIN only).
  const canResolve = session.user.platform_role === 'ADMIN';
  const { discrepancies } = await serverFetch<ListAdminDiscrepanciesResponse>('/v1/admin/reconciliation-discrepancies');

  return (
    <div>
      <h1 className="mb-6 text-xl font-semibold">Reconciliation discrepancies</h1>
      <DataTable
        rows={discrepancies}
        empty="No discrepancies."
        columns={[
          { header: 'Kind', cell: (r) => r.kind },
          { header: 'Severity', cell: (r) => <StatusBadge status={r.severity} /> },
          { header: 'Subject', cell: (r) => `${r.subject_type} ${r.subject_id.slice(0, 10)}…` },
          { header: 'Network', cell: (r) => r.network ?? '—' },
          { header: 'Expected', cell: (r) => r.expected_value ?? '—' },
          { header: 'Actual', cell: (r) => r.actual_value ?? '—' },
          { header: 'Resolved', cell: (r) => (r.resolved_at ? new Date(r.resolved_at).toLocaleString() : 'open') },
          { header: 'Created', cell: (r) => new Date(r.created_at).toLocaleString() },
          {
            header: 'Actions',
            cell: (r) => (canResolve && !r.resolved_at ? <ResolveDiscrepancyForm id={r.id} /> : '—'),
          },
        ]}
      />
    </div>
  );
}
