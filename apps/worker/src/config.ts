/**
 * Environment access for the worker, centralised and fail-fast - mirrors
 * `apps/api/src/config/env.ts`'s philosophy: a missing required value should
 * crash on boot, not on the first poll tick that happens to touch it.
 *
 * Per-endpoint policy (`max_attempts`, `timeout_ms`) lives on the
 * `webhook_endpoints` row itself (set when the merchant registers the
 * endpoint), not here - this config only covers how the WORKER PROCESS
 * behaves, not per-endpoint delivery policy.
 */

export interface WorkerConfig {
  nodeEnv: string;
  databaseUrl: string;
  webhookPollIntervalMs: number;
  webhookBlockPrivateNetworks: boolean;
  webhookDisableAfterConsecutiveFailures: number;
  webhookBatchSize: number;
  expirySweepIntervalMs: number;
  expirySweepBatchSize: number;
  /**
   * How often the whole ledger is reconciled (Phase 16/C6). Reconciliation
   * recomputes every active account's balance from its full entry history
   * (`packages/ledger`'s `reconcileAccount`) - not a cheap query - so this
   * defaults to a much coarser interval than the other loops.
   */
  reconciliationIntervalMs: number;
  /** How often webhook backlog, settlement status and open-discrepancy gauges are re-sampled. */
  financialHealthIntervalMs: number;
  /** `/health`, `/ready`, `/metrics` - never a publicly routed port (ADR 0019). */
  healthPort: number;
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (!value) throw new Error(`missing required environment variable: ${key}`);
  return value;
}

function int(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) throw new Error(`${key} must be an integer, got "${raw}"`);
  return parsed;
}

function bool(env: NodeJS.ProcessEnv, key: string, fallback: boolean): boolean {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  return raw === 'true';
}

export function loadWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  return {
    nodeEnv: env.NODE_ENV ?? 'development',
    databaseUrl: required(env, 'DATABASE_URL'),
    webhookPollIntervalMs: int(env, 'WORKER_WEBHOOK_POLL_INTERVAL_MS', 5000),
    webhookBlockPrivateNetworks: bool(env, 'WEBHOOK_BLOCK_PRIVATE_NETWORKS', true),
    webhookDisableAfterConsecutiveFailures: int(env, 'WEBHOOK_DISABLE_AFTER_CONSECUTIVE_FAILURES', 50),
    webhookBatchSize: int(env, 'WORKER_WEBHOOK_BATCH_SIZE', 100),
    expirySweepIntervalMs: int(env, 'WORKER_EXPIRY_SWEEP_INTERVAL_MS', 30_000),
    expirySweepBatchSize: int(env, 'WORKER_EXPIRY_SWEEP_BATCH_SIZE', 200),
    reconciliationIntervalMs: int(env, 'WORKER_RECONCILIATION_INTERVAL_MS', 3_600_000),
    financialHealthIntervalMs: int(env, 'WORKER_FINANCIAL_HEALTH_INTERVAL_MS', 30_000),
    healthPort: int(env, 'WORKER_HEALTH_PORT', 9465),
  };
}

/**
 * `WEBHOOK_BLOCK_PRIVATE_NETWORKS=false` disables the SSRF guard on
 * merchant-supplied webhook URLs (the worker would happily POST a payment
 * event to `http://169.254.169.254/...` or an internal service). Defaults to
 * `true`, so this only fires when someone has deliberately overridden it -
 * exactly the case a production boot should refuse rather than warn about.
 */
export function validateProductionConfig(config: WorkerConfig): void {
  if (config.nodeEnv !== 'production') return;
  if (!config.webhookBlockPrivateNetworks) {
    throw new Error(
      'refusing to start in production with WEBHOOK_BLOCK_PRIVATE_NETWORKS=false - this disables the SSRF guard on merchant-supplied webhook URLs',
    );
  }
}
