'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiPost } from '@/lib/api-client';
import { ApiError } from '@/lib/api';

export function RevokeApiKeyButton({ id, merchantId }: { id: string; merchantId: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onClick() {
    if (!window.confirm('Revoke this API key? This cannot be undone.')) return;
    setSubmitting(true);
    setError(null);
    try {
      await apiPost(`/v1/merchant/me/api-keys/${id}/revoke`, undefined, merchantId);
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
        {submitting ? 'Revoking…' : 'Revoke'}
      </button>
      {error && <p className="text-xs text-red-400">{error}</p>}
    </div>
  );
}
