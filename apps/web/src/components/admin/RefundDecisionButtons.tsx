'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiPost } from '@/lib/api-client';
import { ApiError } from '@/lib/api';

export function RefundDecisionButtons({ id, status }: { id: string; status: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState<'approve' | 'reject' | null>(null);

  // Mirrors AdminRefundsService's guard: only decidable while REQUESTED or
  // still in COMPLIANCE_REVIEW.
  if (status !== 'REQUESTED' && status !== 'COMPLIANCE_REVIEW') return <span>—</span>;

  async function decide(action: 'approve' | 'reject') {
    if (action === 'reject' && !window.confirm('Reject this refund?')) return;
    setSubmitting(action);
    setError(null);
    try {
      await apiPost(`/v1/admin/refunds/${id}/${action}`);
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong.');
    } finally {
      setSubmitting(null);
    }
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex gap-2">
        <button
          onClick={() => decide('approve')}
          disabled={submitting !== null}
          className="text-xs text-emerald-400 hover:text-emerald-300 disabled:opacity-50"
        >
          {submitting === 'approve' ? 'Approving…' : 'Approve'}
        </button>
        <button
          onClick={() => decide('reject')}
          disabled={submitting !== null}
          className="text-xs text-red-400 hover:text-red-300 disabled:opacity-50"
        >
          {submitting === 'reject' ? 'Rejecting…' : 'Reject'}
        </button>
      </div>
      {error && <p className="text-xs text-red-400">{error}</p>}
    </div>
  );
}
