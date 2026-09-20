'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiPost } from '@/lib/api-client';
import { ApiError } from '@/lib/api';

export function MerchantSuspendButton({ id, status }: { id: string; status: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (status !== 'ACTIVE' && status !== 'SUSPENDED') return null;

  async function onClick() {
    const action = status === 'ACTIVE' ? 'suspend' : 'reactivate';
    if (action === 'suspend' && !window.confirm('Suspend this merchant? They will be unable to process payments.')) return;
    setSubmitting(true);
    setError(null);
    try {
      await apiPost(`/v1/admin/merchants/${id}/${action}`);
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong.');
    } finally {
      // This same component instance is reused across the status change
      // (DataTable keys rows by id, not status) - without resetting here,
      // a successful suspend/reactivate left the button permanently
      // disabled showing "…", since only the catch path used to clear it.
      setSubmitting(false);
    }
  }

  return (
    <div>
      <button
        onClick={onClick}
        disabled={submitting}
        className={`text-xs disabled:opacity-50 ${status === 'ACTIVE' ? 'text-red-400 hover:text-red-300' : 'text-emerald-400 hover:text-emerald-300'}`}
      >
        {submitting ? '…' : status === 'ACTIVE' ? 'Suspend' : 'Reactivate'}
      </button>
      {error && <p className="text-xs text-red-400">{error}</p>}
    </div>
  );
}
