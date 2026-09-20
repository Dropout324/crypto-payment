'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiDelete } from '@/lib/api-client';
import { ApiError } from '@/lib/api';

export function RemoveMemberButton({ id, merchantId }: { id: string; merchantId: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onClick() {
    if (!window.confirm('Remove this team member?')) return;
    setSubmitting(true);
    setError(null);
    try {
      await apiDelete(`/v1/merchant/me/members/${id}`, merchantId);
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div>
      <button
        onClick={onClick}
        disabled={submitting}
        className="text-xs text-red-400 hover:text-red-300 disabled:opacity-50"
      >
        {submitting ? 'Removing…' : 'Remove'}
      </button>
      {error && <p className="text-xs text-red-400">{error}</p>}
    </div>
  );
}
