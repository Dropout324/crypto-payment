import { requireSession } from '@/lib/session';
import { resolveCurrentMerchantId, merchantFetch } from '@/lib/merchant';
import type { WebhookEndpointResponse } from '@/lib/types';
import { DataTable } from '@/components/DataTable';
import { CreateWebhookEndpointForm } from '@/components/dashboard/CreateWebhookEndpointForm';
import { WebhookEnabledToggle } from '@/components/dashboard/WebhookEnabledToggle';
import { EditEventTypesForm } from '@/components/dashboard/EditEventTypesForm';
import { WebhookRowActions } from '@/components/dashboard/WebhookRowActions';

export default async function WebhookEndpointsPage() {
  const session = await requireSession();
  const merchantId = await resolveCurrentMerchantId(session.memberships);
  if (!merchantId) return null;

  const role = session.memberships.find((m) => m.merchant_id === merchantId)?.role;
  // Mirrors MerchantPermission.WEBHOOKS_MANAGE in apps/api/src/auth/permissions.ts.
  const canManage = role === 'OWNER' || role === 'ADMIN' || role === 'DEVELOPER';

  const endpoints = await merchantFetch<WebhookEndpointResponse[]>('/v1/merchant/me/webhook-endpoints', merchantId);

  return (
    <div>
      <h1 className="mb-6 text-xl font-semibold">Webhook endpoints</h1>
      {canManage && <CreateWebhookEndpointForm merchantId={merchantId} />}
      <DataTable
        rows={endpoints}
        empty="No webhook endpoints configured."
        columns={[
          { header: 'URL', cell: (r) => <span className="font-mono text-xs">{r.url}</span> },
          {
            header: 'Events',
            cell: (r) => (
              <EditEventTypesForm id={r.id} merchantId={merchantId} eventTypes={r.event_types} canManage={canManage} />
            ),
          },
          {
            header: 'Enabled',
            cell: (r) => <WebhookEnabledToggle id={r.id} merchantId={merchantId} enabled={r.enabled} canManage={canManage} />,
          },
          { header: 'Failures', cell: (r) => r.consecutive_failures },
          { header: 'Disabled reason', cell: (r) => r.disabled_reason ?? '—' },
          {
            header: 'Actions',
            cell: (r) => <WebhookRowActions id={r.id} merchantId={merchantId} canManage={canManage} />,
          },
        ]}
      />
    </div>
  );
}
