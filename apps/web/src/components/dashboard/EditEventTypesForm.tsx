'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiPatch } from '@/lib/api-client';
import { ApiError } from '@/lib/api';

export function EditEventTypesForm({
  id,
  merchantId,
  eventTypes,
  canManage,
}: {
  id: string;
  merchantId: string;
  eventTypes: string[];
  canManage: boolean;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(eventTypes.join(', '));
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (!canManage) {
    return <span>{eventTypes.length > 0 ? eventTypes.join(', ') : 'all events'}</span>;
  }

  if (!editing) {
    return (
      <button onClick={() => setEditing(true)} className="text-left hover:underline">
        {eventTypes.length > 0 ? eventTypes.join(', ') : 'all events'}
      </button>
    );
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const event_types = value
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      await apiPatch(`/v1/merchant/me/webhook-endpoints/${id}`, { event_types }, merchantId);
      setEditing(false);
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-1">
      <div className="flex gap-1">
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="w-48 rounded border border-zinc-800 bg-zinc-900 px-2 py-1 text-xs outline-none focus:border-zinc-600"
        />
        <button type="submit" disabled={submitting} className="text-xs text-indigo-400 hover:text-indigo-300 disabled:opacity-50">
          Save
        </button>
        <button type="button" onClick={() => setEditing(false)} className="text-xs text-zinc-500 hover:text-zinc-300">
          Cancel
        </button>
      </div>
      {error && <p className="text-xs text-red-400">{error}</p>}
    </form>
  );
}
