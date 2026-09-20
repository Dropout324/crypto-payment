import { requireSession } from '@/lib/session';
import { resolveCurrentMerchantId, merchantFetch } from '@/lib/merchant';
import type { MerchantSettingsResponse } from '@/lib/types';
import { StatusBadge } from '@/components/StatusBadge';

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="border-b border-zinc-900 py-2 last:border-0">
      <dt className="text-xs text-zinc-500">{label}</dt>
      <dd className="mt-0.5 text-sm">{value}</dd>
    </div>
  );
}

export default async function SettingsPage() {
  const session = await requireSession();
  const merchantId = await resolveCurrentMerchantId(session.memberships);
  if (!merchantId) return null;

  const s = await merchantFetch<MerchantSettingsResponse>('/v1/merchant/me/settings', merchantId);

  return (
    <div>
      <h1 className="mb-6 text-xl font-semibold">Settings</h1>
      <dl className="max-w-md rounded-lg border border-zinc-800 p-4">
        <Field label="Name" value={s.name} />
        <Field label="Slug" value={s.slug} />
        <Field label="Status" value={<StatusBadge status={s.status} />} />
        <Field label="Settlement currency" value={s.settlement_currency} />
        <Field label="Wallet mode" value={s.wallet_mode} />
        <Field label="Underpayment policy" value={`${s.underpayment_policy} (tolerance ${s.underpayment_tolerance_bps} bps)`} />
        <Field label="Overpayment policy" value={`${s.overpayment_policy} (tolerance ${s.overpayment_tolerance_bps} bps)`} />
        <Field label="Invoice expiry" value={`${s.invoice_expiry_seconds}s`} />
        <Field label="Fee" value={`${s.fee_bps} bps`} />
      </dl>
    </div>
  );
}
