'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiPost } from '@/lib/api-client';
import { ApiError } from '@/lib/api';

export function ComplianceReviewForm({ id }: { id: string }) {
  const router = useRouter();
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState<'APPROVE' | 'REJECT' | null>(null);

  async function decide(decision: 'APPROVE' | 'REJECT') {
    setSubmitting(decision);
    setError(null);
    try {
      await apiPost(`/v1/admin/compliance-checks/${id}/review`, { decision, note: note.trim() || undefined });
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong.');
    } finally {
      setSubmitting(null);
    }
  }

  return (
    <div className="flex flex-col gap-1">
      <input
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Note (optional)"
        className="w-40 rounded border border-zinc-800 bg-zinc-900 px-2 py-1 text-xs outline-none focus:border-zinc-600"
      />
      <div className="flex gap-2">
        <button
          onClick={() => decide('APPROVE')}
          disabled={submitting !== null}
          className="text-xs text-emerald-400 hover:text-emerald-300 disabled:opacity-50"
        >
          {submitting === 'APPROVE' ? 'Approving…' : 'Approve'}
        </button>
        <button
          onClick={() => decide('REJECT')}
          disabled={submitting !== null}
          className="text-xs text-red-400 hover:text-red-300 disabled:opacity-50"
        >
          {submitting === 'REJECT' ? 'Rejecting…' : 'Reject'}
        </button>
      </div>
      {error && <p className="text-xs text-red-400">{error}</p>}
    </div>
  );
}
