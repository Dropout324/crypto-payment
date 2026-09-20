'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiPatch } from '@/lib/api-client';
import { ApiError } from '@/lib/api';

const ROLES = ['OWNER', 'ADMIN', 'DEVELOPER', 'VIEWER'] as const;

export function MemberRoleSelect({
  id,
  merchantId,
  role,
  canManage,
}: {
  id: string;
  merchantId: string;
  role: string;
  canManage: boolean;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (!canManage) return <span>{role}</span>;

  async function onChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const nextRole = e.target.value;
    setSubmitting(true);
    setError(null);
    try {
      // Guarded server-side too: MerchantMembersService refuses to demote the
      // last remaining OWNER (ConflictError), surfaced here as ApiError.
      await apiPatch(`/v1/merchant/me/members/${id}`, { role: nextRole }, merchantId);
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div>
      <select
        defaultValue={role}
        onChange={onChange}
        disabled={submitting}
        className="rounded border border-zinc-800 bg-zinc-900 px-2 py-1 text-xs outline-none focus:border-zinc-600 disabled:opacity-50"
      >
        {ROLES.map((r) => (
          <option key={r} value={r}>
            {r}
          </option>
        ))}
      </select>
      {error && <p className="text-xs text-red-400">{error}</p>}
    </div>
  );
}
