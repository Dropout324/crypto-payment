import { requireSession } from '@/lib/session';
import { resolveCurrentMerchantId, merchantFetch } from '@/lib/merchant';
import type { ApiKeyResponse } from '@/lib/types';
import { DataTable } from '@/components/DataTable';
import { StatusBadge } from '@/components/StatusBadge';
import { CreateApiKeyForm } from '@/components/dashboard/CreateApiKeyForm';
import { RevokeApiKeyButton } from '@/components/dashboard/RevokeApiKeyButton';

export default async function ApiKeysPage() {
  const session = await requireSession();
  const merchantId = await resolveCurrentMerchantId(session.memberships);
  if (!merchantId) return null;

  const role = session.memberships.find((m) => m.merchant_id === merchantId)?.role;
  // Mirrors MerchantPermission.API_KEYS_MANAGE in apps/api/src/auth/permissions.ts.
  // This only hides the controls VIEWER can't use - the API independently
  // rejects the same request regardless of what the UI sends.
  const canManage = role === 'OWNER' || role === 'ADMIN' || role === 'DEVELOPER';

  const keys = await merchantFetch<ApiKeyResponse[]>('/v1/merchant/me/api-keys', merchantId);

  return (
    <div>
      <h1 className="mb-6 text-xl font-semibold">API keys</h1>
      {canManage && <CreateApiKeyForm merchantId={merchantId} />}
      <DataTable
        rows={keys}
        empty="No API keys yet."
        columns={[
          { header: 'Name', cell: (r) => r.name },
          { header: 'Prefix', cell: (r) => <span className="font-mono text-xs">{r.key_prefix}…</span> },
          { header: 'Mode', cell: (r) => (r.livemode ? 'Live' : 'Test') },
          { header: 'Scopes', cell: (r) => r.scopes.join(', ') },
          { header: 'Status', cell: (r) => <StatusBadge status={r.status} /> },
          { header: 'Last used', cell: (r) => (r.last_used_at ? new Date(r.last_used_at).toLocaleString() : 'never') },
          {
            header: 'Actions',
            cell: (r) =>
              canManage && r.status === 'ACTIVE' ? <RevokeApiKeyButton id={r.id} merchantId={merchantId} /> : '—',
          },
        ]}
      />
    </div>
  );
}
