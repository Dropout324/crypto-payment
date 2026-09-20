'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiPost } from '@/lib/api-client';
import { ApiError } from '@/lib/api';
import type { CreatedWebhookEndpointResponse, TestWebhookResult } from '@/lib/types';

/** Test-send needs no extra permission beyond membership (see webhook-endpoints.controller.ts), so every role sees it. Rotate is API_KEYS/WEBHOOKS_MANAGE-gated, same as create. */
export function WebhookRowActions({ id, merchantId, canManage }: { id: string; merchantId: string; canManage: boolean }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState<'rotate' | 'test' | null>(null);
  const [newSecret, setNewSecret] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<TestWebhookResult | null>(null);

  async function onRotate() {
    if (!window.confirm('Rotate this endpoint\'s secret? The old secret stops verifying new deliveries shortly after.')) return;
    setSubmitting('rotate');
    setError(null);
    try {
      const res = await apiPost<CreatedWebhookEndpointResponse>(
        `/v1/merchant/me/webhook-endpoints/${id}/rotate-secret`,
        undefined,
        merchantId,
      );
      setNewSecret(res.secret);
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong.');
    } finally {
      setSubmitting(null);
    }
  }

  async function onTest() {
    setSubmitting('test');
    setError(null);
    setTestResult(null);
    try {
      const result = await apiPost<TestWebhookResult>(`/v1/merchant/me/webhook-endpoints/${id}/test`, undefined, merchantId);
      setTestResult(result);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong.');
    } finally {
      setSubmitting(null);
    }
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex gap-3">
        <button onClick={onTest} disabled={submitting !== null} className="text-xs text-zinc-300 hover:text-white disabled:opacity-50">
          {submitting === 'test' ? 'Testing…' : 'Test'}
        </button>
        {canManage && (
          <button
            onClick={onRotate}
            disabled={submitting !== null}
            className="text-xs text-amber-400 hover:text-amber-300 disabled:opacity-50"
          >
            {submitting === 'rotate' ? 'Rotating…' : 'Rotate secret'}
          </button>
        )}
      </div>
      {error && <p className="text-xs text-red-400">{error}</p>}
      {testResult && (
        <p className={`text-xs ${testResult.delivered ? 'text-emerald-400' : 'text-red-400'}`}>
          {testResult.delivered ? `Delivered (${testResult.http_status})` : `Failed${testResult.error ? `: ${testResult.error}` : ''}`}
          {` in ${testResult.response_time_ms}ms`}
        </p>
      )}
      {newSecret && (
        <div className="max-w-xs rounded border border-emerald-800 bg-emerald-500/10 p-1.5">
          <p className="text-xs text-emerald-400">New secret - copy now:</p>
          <code className="block break-all font-mono text-[10px] text-zinc-200">{newSecret}</code>
        </div>
      )}
    </div>
  );
}
