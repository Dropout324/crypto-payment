'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiPost } from '@/lib/api-client';
import { ApiError } from '@/lib/api';

export function ResolveDiscrepancyForm({ id }: { id: string }) {
  const router = useRouter();
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!note.trim()) {
      setError('A resolution note is required.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await apiPost(`/v1/admin/reconciliation-discrepancies/${id}/resolve`, { resolution_note: note.trim() });
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-1">
      <input
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Resolution note"
        className="w-40 rounded border border-zinc-800 bg-zinc-900 px-2 py-1 text-xs outline-none focus:border-zinc-600"
      />
      <button type="submit" disabled={submitting} className="text-xs text-indigo-400 hover:text-indigo-300 disabled:opacity-50">
        {submitting ? 'Resolving…' : 'Resolve'}
      </button>
      {error && <p className="text-xs text-red-400">{error}</p>}
    </form>
  );
}
