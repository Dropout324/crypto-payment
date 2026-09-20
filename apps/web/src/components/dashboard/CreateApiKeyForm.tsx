'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiPost } from '@/lib/api-client';
import { ApiError } from '@/lib/api';
import type { CreatedApiKeyResponse } from '@/lib/types';

export function CreateApiKeyForm({ merchantId }: { merchantId: string }) {
  const router = useRouter();
  const [name, setName] = useState('');
  const [livemode, setLivemode] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [created, setCreated] = useState<CreatedApiKeyResponse | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const key = await apiPost<CreatedApiKeyResponse>('/v1/merchant/me/api-keys', { name, livemode }, merchantId);
      setCreated(key);
      setName('');
      setLivemode(false);
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="mb-6 rounded-lg border border-zinc-800 p-4">
      <form onSubmit={onSubmit} className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1">
          <label htmlFor="api-key-name" className="text-xs text-zinc-400">
            Name
          </label>
          <input
            id="api-key-name"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="rounded-md border border-zinc-800 bg-zinc-900 px-3 py-1.5 text-sm outline-none focus:border-zinc-600"
          />
        </div>
        <label className="flex items-center gap-2 pb-1.5 text-sm text-zinc-400">
          <input type="checkbox" checked={livemode} onChange={(e) => setLivemode(e.target.checked)} />
          Live mode
        </label>
        <button
          type="submit"
          disabled={submitting}
          className="rounded-md bg-indigo-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-400 disabled:opacity-50"
        >
          {submitting ? 'Creating…' : 'Create API key'}
        </button>
      </form>
      {error && <p className="mt-2 text-sm text-red-400">{error}</p>}
      {created && (
        <div className="mt-3 rounded-md border border-emerald-800 bg-emerald-500/10 p-3 text-sm">
          <p className="text-emerald-400">API key created. Copy it now - it won&apos;t be shown again.</p>
          <code className="mt-1 block break-all font-mono text-xs text-zinc-200">{created.plaintext}</code>
        </div>
      )}
    </div>
  );
}
