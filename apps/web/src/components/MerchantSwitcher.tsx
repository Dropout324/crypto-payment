'use client';

import { useRouter } from 'next/navigation';
import type { Membership } from '@/lib/types';

export function MerchantSwitcher({ memberships, currentId }: { memberships: Membership[]; currentId: string }) {
  const router = useRouter();

  if (memberships.length <= 1) {
    return <div className="mb-6 truncate text-xs text-zinc-500">{memberships[0]?.merchant_name}</div>;
  }

  return (
    <select
      value={currentId}
      onChange={(e) => {
        document.cookie = `gw_merchant=${e.target.value}; path=/; max-age=31536000`;
        router.refresh();
      }}
      className="mb-6 rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1.5 text-sm text-zinc-100"
    >
      {memberships.map((m) => (
        <option key={m.merchant_id} value={m.merchant_id}>
          {m.merchant_name}
        </option>
      ))}
    </select>
  );
}
