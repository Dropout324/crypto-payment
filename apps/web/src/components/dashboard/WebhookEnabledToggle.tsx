'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiPatch } from '@/lib/api-client';
import { ApiError } from '@/lib/api';
import { StatusBadge } from '@/components/StatusBadge';

export function WebhookEnabledToggle({
  id,
  merchantId,
  enabled,
  canManage,
}: {
  id: string;
  merchantId: string;
  enabled: boolean;
  canManage: boolean;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (!canManage) {
    return <StatusBadge status={enabled ? 'ACTIVE' : 'DISABLED'} />;
  }

  async function onClick() {
    setSubmitting(true);
    setError(null);
    try {
      await apiPatch(`/v1/merchant/me/webhook-endpoints/${id}`, { enabled: !enabled }, merchantId);
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong.');
    } finally {
      // This instance persists across the refresh (same row id) - without
      // resetting here, a successful toggle left the button permanently
      // disabled, since only the catch path used to clear it.
      setSubmitting(false);
    }
  }

  return (
    <div>
      <button
        onClick={onClick}
        disabled={submitting}
        className="flex items-center gap-2 text-left disabled:opacity-50"
        title="Toggle enabled"
      >
        <StatusBadge status={enabled ? 'ACTIVE' : 'DISABLED'} />
      </button>
      {error && <p className="text-xs text-red-400">{error}</p>}
    </div>
  );
}
