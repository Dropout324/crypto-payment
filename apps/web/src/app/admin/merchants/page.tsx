import { requirePlatformRole, serverFetch } from '@/lib/session';
import type { ListAdminMerchantsResponse } from '@/lib/types';
import { DataTable } from '@/components/DataTable';
import { StatusBadge } from '@/components/StatusBadge';
import { MerchantSuspendButton } from '@/components/admin/MerchantSuspendButton';

export default async function AdminMerchantsPage() {
  const session = await requirePlatformRole();
  // Mirrors PlatformPermission.MERCHANTS_MANAGE in apps/api/src/auth/permissions.ts (ADMIN only).
  const canManage = session.user.platform_role === 'ADMIN';
  const { merchants } = await serverFetch<ListAdminMerchantsResponse>('/v1/admin/merchants');

  return (
    <div>
      <h1 className="mb-6 text-xl font-semibold">Merchants</h1>
      <DataTable
        rows={merchants}
        empty="No merchants."
        columns={[
          { header: 'Name', cell: (r) => r.name },
          { header: 'Slug', cell: (r) => r.slug },
          { header: 'Status', cell: (r) => <StatusBadge status={r.status} /> },
          { header: 'Country', cell: (r) => r.country_code ?? '—' },
          { header: 'Wallet mode', cell: (r) => r.wallet_mode },
          { header: 'KYB', cell: (r) => <StatusBadge status={r.kyb_status} /> },
          { header: 'Fee', cell: (r) => `${r.fee_bps} bps` },
          { header: 'Created', cell: (r) => new Date(r.created_at).toLocaleDateString() },
          {
            header: 'Actions',
            cell: (r) => (canManage ? <MerchantSuspendButton id={r.id} status={r.status} /> : '—'),
          },
        ]}
      />
    </div>
  );
}
