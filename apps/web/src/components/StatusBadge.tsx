const POSITIVE = new Set(['PAID', 'ACTIVE', 'CONFIRMED', 'COMPLETED', 'APPROVED', 'PASSED', 'MATCHED']);
const NEGATIVE = new Set([
  'FAILED',
  'EXPIRED',
  'CANCELLED',
  'REJECTED',
  'REVOKED',
  'SUSPENDED',
  'FLAGGED',
  'DISABLED',
  'CRITICAL',
]);

export function StatusBadge({ status }: { status: string }) {
  const tone = POSITIVE.has(status) ? 'positive' : NEGATIVE.has(status) ? 'negative' : 'neutral';
  const classes =
    tone === 'positive'
      ? 'bg-emerald-500/10 text-emerald-400'
      : tone === 'negative'
        ? 'bg-red-500/10 text-red-400'
        : 'bg-zinc-500/10 text-zinc-400';

  return <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${classes}`}>{status}</span>;
}
