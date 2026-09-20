import { requireSession } from '@/lib/session';
import { resolveCurrentMerchantId, merchantFetch } from '@/lib/merchant';
import type { MemberResponse } from '@/lib/types';
import { DataTable } from '@/components/DataTable';
import { AddMemberForm } from '@/components/dashboard/AddMemberForm';
import { MemberRoleSelect } from '@/components/dashboard/MemberRoleSelect';
import { RemoveMemberButton } from '@/components/dashboard/RemoveMemberButton';

export default async function MembersPage() {
  const session = await requireSession();
  const merchantId = await resolveCurrentMerchantId(session.memberships);
  if (!merchantId) return null;

  const role = session.memberships.find((m) => m.merchant_id === merchantId)?.role;
  // Mirrors MerchantPermission.MEMBERS_MANAGE in apps/api/src/auth/permissions.ts -
  // deliberately narrower than every other "manage" permission: OWNER only.
  const canManage = role === 'OWNER';

  const members = await merchantFetch<MemberResponse[]>('/v1/merchant/me/members', merchantId);

  return (
    <div>
      <h1 className="mb-6 text-xl font-semibold">Team</h1>
      {canManage && <AddMemberForm merchantId={merchantId} />}
      <DataTable
        rows={members}
        empty="No team members."
        columns={[
          { header: 'Email', cell: (r) => r.email },
          { header: 'Name', cell: (r) => r.full_name ?? '—' },
          { header: 'Role', cell: (r) => <MemberRoleSelect id={r.id} merchantId={merchantId} role={r.role} canManage={canManage} /> },
          { header: 'Added', cell: (r) => new Date(r.created_at).toLocaleDateString() },
          {
            header: 'Actions',
            cell: (r) => (canManage ? <RemoveMemberButton id={r.id} merchantId={merchantId} /> : '—'),
          },
        ]}
      />
    </div>
  );
}
