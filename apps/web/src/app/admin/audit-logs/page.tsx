import { redirect } from 'next/navigation';
import { requirePlatformRole, serverFetch } from '@/lib/session';
import type { ListAdminAuditLogsResponse } from '@/lib/types';
import { DataTable } from '@/components/DataTable';

function buildQuery(filters: Record<string, string | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value) params.set(key, value);
  }
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

export default async function AdminAuditLogsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requirePlatformRole();
  // AUDIT_LOGS_READ is held by COMPLIANCE_OFFICER and ADMIN only, deliberately
  // excluding SUPPORT (see apps/api/src/admin/admin-audit-logs.controller.ts) -
  // this page enforces the same boundary before ever calling the API.
  if (session.user.platform_role === 'SUPPORT') redirect('/admin/merchants');

  const sp = await searchParams;
  const first = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);
  const filters = {
    merchant_id: first(sp.merchant_id),
    actor_id: first(sp.actor_id),
    action: first(sp.action),
    resource_type: first(sp.resource_type),
  };
  const cursor = first(sp.cursor);

  const { audit_logs, next_cursor } = await serverFetch<ListAdminAuditLogsResponse>(
    `/v1/admin/audit-logs${buildQuery({ ...filters, cursor })}`,
  );

  return (
    <div>
      <h1 className="mb-6 text-xl font-semibold">Audit log</h1>
      <form method="GET" className="mb-6 flex flex-wrap items-end gap-3 rounded-lg border border-zinc-800 p-4">
        <div className="flex flex-col gap-1">
          <label htmlFor="merchant_id" className="text-xs text-zinc-400">
            Merchant ID
          </label>
          <input
            id="merchant_id"
            name="merchant_id"
            defaultValue={filters.merchant_id ?? ''}
            className="rounded-md border border-zinc-800 bg-zinc-900 px-3 py-1.5 text-sm outline-none focus:border-zinc-600"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="actor_id" className="text-xs text-zinc-400">
            Actor ID
          </label>
          <input
            id="actor_id"
            name="actor_id"
            defaultValue={filters.actor_id ?? ''}
            className="rounded-md border border-zinc-800 bg-zinc-900 px-3 py-1.5 text-sm outline-none focus:border-zinc-600"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="action" className="text-xs text-zinc-400">
            Action
          </label>
          <input
            id="action"
            name="action"
            defaultValue={filters.action ?? ''}
            placeholder="e.g. refund.approved"
            className="rounded-md border border-zinc-800 bg-zinc-900 px-3 py-1.5 text-sm outline-none focus:border-zinc-600"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="resource_type" className="text-xs text-zinc-400">
            Resource type
          </label>
          <input
            id="resource_type"
            name="resource_type"
            defaultValue={filters.resource_type ?? ''}
            className="rounded-md border border-zinc-800 bg-zinc-900 px-3 py-1.5 text-sm outline-none focus:border-zinc-600"
          />
        </div>
        <button
          type="submit"
          className="rounded-md bg-indigo-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-400"
        >
          Filter
        </button>
      </form>
      <DataTable
        rows={audit_logs}
        empty="No audit log entries match these filters."
        columns={[
          { header: 'When', cell: (r) => new Date(r.created_at).toLocaleString() },
          { header: 'Actor', cell: (r) => `${r.actor_type}:${(r.user_id ?? r.actor_id ?? 'system').slice(0, 12)}` },
          { header: 'Action', cell: (r) => r.action },
          { header: 'Resource', cell: (r) => `${r.resource_type} ${r.resource_id ? r.resource_id.slice(0, 10) + '…' : '—'}` },
          { header: 'Merchant', cell: (r) => (r.merchant_id ? r.merchant_id.slice(0, 10) + '…' : '—') },
          { header: 'IP', cell: (r) => r.ip_address ?? '—' },
        ]}
      />
      {next_cursor && (
        <a
          href={`/admin/audit-logs${buildQuery({ ...filters, cursor: next_cursor })}`}
          className="mt-4 inline-block text-sm text-indigo-400 hover:text-indigo-300"
        >
          Next page →
        </a>
      )}
    </div>
  );
}
