'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiPost } from '@/lib/api-client';
import { ApiError } from '@/lib/api';
import type { CreatedWebhookEndpointResponse } from '@/lib/types';

export function CreateWebhookEndpointForm({ merchantId }: { merchantId: string }) {
  const router = useRouter();
  const [url, setUrl] = useState('');
  const [eventTypes, setEventTypes] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [created, setCreated] = useState<CreatedWebhookEndpointResponse | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const event_types = eventTypes
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const endpoint = await apiPost<CreatedWebhookEndpointResponse>(
        '/v1/merchant/me/webhook-endpoints',
        { url, event_types: event_types.length > 0 ? event_types : undefined },
        merchantId,
      );
      setCreated(endpoint);
      setUrl('');
      setEventTypes('');
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
        <div className="flex min-w-64 flex-col gap-1">
          <label htmlFor="webhook-url" className="text-xs text-zinc-400">
            URL
          </label>
          <input
            id="webhook-url"
            type="url"
            required
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://example.com/webhooks/gateway"
            className="rounded-md border border-zinc-800 bg-zinc-900 px-3 py-1.5 text-sm outline-none focus:border-zinc-600"
          />
        </div>
        <div className="flex min-w-48 flex-col gap-1">
          <label htmlFor="webhook-events" className="text-xs text-zinc-400">
            Event types (comma-separated, optional)
          </label>
          <input
            id="webhook-events"
            value={eventTypes}
            onChange={(e) => setEventTypes(e.target.value)}
            placeholder="invoice.paid, invoice.expired"
            className="rounded-md border border-zinc-800 bg-zinc-900 px-3 py-1.5 text-sm outline-none focus:border-zinc-600"
          />
        </div>
        <button
          type="submit"
          disabled={submitting}
          className="rounded-md bg-indigo-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-400 disabled:opacity-50"
        >
          {submitting ? 'Creating…' : 'Add endpoint'}
        </button>
      </form>
      {error && <p className="mt-2 text-sm text-red-400">{error}</p>}
      {created && (
        <div className="mt-3 rounded-md border border-emerald-800 bg-emerald-500/10 p-3 text-sm">
          <p className="text-emerald-400">Webhook endpoint created. Copy the secret now - it won&apos;t be shown again.</p>
          <code className="mt-1 block break-all font-mono text-xs text-zinc-200">{created.secret}</code>
        </div>
      )}
    </div>
  );
}
