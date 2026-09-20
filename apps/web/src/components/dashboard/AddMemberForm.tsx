'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiPost } from '@/lib/api-client';
import { ApiError } from '@/lib/api';

const ROLES = ['OWNER', 'ADMIN', 'DEVELOPER', 'VIEWER'] as const;

export function AddMemberForm({ merchantId }: { merchantId: string }) {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<(typeof ROLES)[number]>('VIEWER');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await apiPost('/v1/merchant/me/members', { email, role }, merchantId);
      setEmail('');
      setRole('VIEWER');
      router.refresh();
    } catch (err) {
      // Most common failure here: "user with that email - they must already
      // have an account" (there is no invite/signup flow yet - see
      // apps/api/src/merchant/members.dto.ts), which ApiError's message
      // already communicates.
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="mb-6 rounded-lg border border-zinc-800 p-4">
      <form onSubmit={onSubmit} className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1">
          <label htmlFor="member-email" className="text-xs text-zinc-400">
            Email (must already have an account)
          </label>
          <input
            id="member-email"
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="rounded-md border border-zinc-800 bg-zinc-900 px-3 py-1.5 text-sm outline-none focus:border-zinc-600"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="member-role" className="text-xs text-zinc-400">
            Role
          </label>
          <select
            id="member-role"
            value={role}
            onChange={(e) => setRole(e.target.value as (typeof ROLES)[number])}
            className="rounded-md border border-zinc-800 bg-zinc-900 px-3 py-1.5 text-sm outline-none focus:border-zinc-600"
          >
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </div>
        <button
          type="submit"
          disabled={submitting}
          className="rounded-md bg-indigo-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-400 disabled:opacity-50"
        >
          {submitting ? 'Adding…' : 'Add member'}
        </button>
      </form>
      {error && <p className="mt-2 text-sm text-red-400">{error}</p>}
    </div>
  );
}
