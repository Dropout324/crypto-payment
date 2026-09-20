import { requireSession } from '@/lib/session';
import { resolveCurrentMerchantId, merchantFetch } from '@/lib/merchant';
import type { BalanceResponse } from '@/lib/types';

export default async function DashboardOverviewPage() {
  const session = await requireSession();
  const merchantId = await resolveCurrentMerchantId(session.memberships);
  if (!merchantId) return null;

  const { balances } = await merchantFetch<BalanceResponse>('/v1/merchant/me/balance', merchantId);

  return (
    <div>
      <h1 className="mb-6 text-xl font-semibold">Overview</h1>
      {balances.length === 0 ? (
        <p className="text-sm text-zinc-500">No balances yet.</p>
      ) : (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          {balances.map((b) => (
            <div key={`${b.network}-${b.asset}`} className="rounded-lg border border-zinc-800 p-4">
              <div className="text-xs text-zinc-500">
                {b.network} · {b.asset}
              </div>
              <div className="mt-1 text-lg font-semibold">{b.available}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
