import { requirePlatformRole, serverFetch } from '@/lib/session';
import type { ListAdminComplianceResponse } from '@/lib/types';
import { DataTable } from '@/components/DataTable';
import { StatusBadge } from '@/components/StatusBadge';
import { ComplianceReviewForm } from '@/components/admin/ComplianceReviewForm';

export default async function AdminCompliancePage() {
  const session = await requirePlatformRole();
  // Mirrors PlatformPermission.COMPLIANCE_REVIEW in apps/api/src/auth/permissions.ts (COMPLIANCE_OFFICER, ADMIN - not SUPPORT).
  const canReview = session.user.platform_role === 'COMPLIANCE_OFFICER' || session.user.platform_role === 'ADMIN';
  const { compliance_checks } = await serverFetch<ListAdminComplianceResponse>('/v1/admin/compliance-checks');

  return (
    <div>
      <h1 className="mb-6 text-xl font-semibold">Compliance checks</h1>
      <DataTable
        rows={compliance_checks}
        empty="No compliance checks."
        columns={[
          { header: 'Subject', cell: (r) => `${r.subject_type} ${r.subject_id.slice(0, 10)}…` },
          { header: 'Check', cell: (r) => r.check_type },
          { header: 'Provider', cell: (r) => r.provider },
          { header: 'Status', cell: (r) => <StatusBadge status={r.status} /> },
          { header: 'Risk score', cell: (r) => r.risk_score ?? '—' },
          { header: 'Reviewed by', cell: (r) => r.reviewed_by ?? '—' },
          { header: 'Created', cell: (r) => new Date(r.created_at).toLocaleString() },
          {
            header: 'Actions',
            cell: (r) => (canReview && r.status === 'PENDING' ? <ComplianceReviewForm id={r.id} /> : '—'),
          },
        ]}
      />
    </div>
  );
}
