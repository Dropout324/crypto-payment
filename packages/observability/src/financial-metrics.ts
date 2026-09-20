import { Counter, Gauge, Histogram, type Registry } from 'prom-client';

/**
 * Financial metrics (ADR - Phase 16 / C6). Distinct from `metrics.ts`'s
 * generic HTTP/poll-loop metrics: every series here exists to back one of
 * the alert rules in `infrastructure/kubernetes/monitoring/alert-rules.yaml`
 * - webhook delivery health, payment/confirmation latency, settlement and
 * reconciliation outcomes, RPC reliability and signing failures. One
 * instance is shared by whichever process actually observes each event
 * (`apps/worker` for webhooks/reconciliation/settlements,
 * `apps/blockchain-monitor` for payment latency/RPC failures, `apps/api` for
 * signing failures) - nothing here assumes all of them run in the same
 * process.
 */
export interface FinancialMetrics {
  /** A webhook delivery attempt that did not succeed, by outcome (`failed` = will retry, `exhausted` = retries used up). */
  webhookDeliveryFailures: Counter<'outcome'>;
  /** Deliveries currently PENDING or FAILED-awaiting-retry, by that status - the backlog an operator needs to see grow. */
  webhookBacklog: Gauge<'status'>;
  /** Wall-clock seconds from invoice creation to the first matching on-chain transfer being sighted. */
  paymentDetectionLatencySeconds: Histogram<never>;
  /** Wall-clock seconds from first sighting to an invoice reaching its confirmed, ledger-credited outcome. */
  paymentConfirmationLatencySeconds: Histogram<never>;
  /** Settlements currently in each `SettlementStatus`, re-sampled on every tick of the collector that owns this gauge. */
  settlementsByStatus: Gauge<'status'>;
  /** A `ReconciliationDiscrepancy` row was created, by kind (`LEDGER_IMBALANCE`, `ORPHANED_CREDIT`, ...). */
  reconciliationDiscrepancies: Counter<'kind'>;
  /** Discrepancies with no `resolvedAt` yet - re-sampled the same way as `settlementsByStatus`. */
  reconciliationOpenDiscrepancies: Gauge<never>;
  /** An adapter call to an RPC provider threw, by network and method - the source for the "RPC provider unavailable" alert. */
  rpcFailures: Counter<'network' | 'method'>;
  /** A signing request was rejected by policy or failed at the backend, by stage (`validation_failed`, `sign_failed`). */
  signingFailures: Counter<'stage'>;
  /** An invoice reached a final, ledger-credited payment outcome - the numerator behind the "abnormal payment processing rate" alert. */
  paymentsProcessed: Counter<never>;
}

const LATENCY_BUCKETS_SECONDS = [1, 5, 15, 30, 60, 120, 300, 600, 1800, 3600, 7200, 21600, 43200, 86400];

export function createFinancialMetrics(registry: Registry): FinancialMetrics {
  return {
    webhookDeliveryFailures: new Counter({
      name: 'gateway_webhook_delivery_failures_total',
      help: 'Webhook delivery attempts that did not succeed, by outcome.',
      labelNames: ['outcome'],
      registers: [registry],
    }),
    webhookBacklog: new Gauge({
      name: 'gateway_webhook_backlog',
      help: 'Webhook deliveries currently PENDING or awaiting retry, by status.',
      labelNames: ['status'],
      registers: [registry],
    }),
    paymentDetectionLatencySeconds: new Histogram({
      name: 'gateway_payment_detection_latency_seconds',
      help: 'Seconds from invoice creation to the first matching on-chain transfer being sighted.',
      buckets: LATENCY_BUCKETS_SECONDS,
      registers: [registry],
    }),
    paymentConfirmationLatencySeconds: new Histogram({
      name: 'gateway_payment_confirmation_latency_seconds',
      help: 'Seconds from first sighting to an invoice reaching its confirmed, ledger-credited outcome.',
      buckets: LATENCY_BUCKETS_SECONDS,
      registers: [registry],
    }),
    settlementsByStatus: new Gauge({
      name: 'gateway_settlements_by_status',
      help: 'Settlements currently in each status, as of the most recent collection tick.',
      labelNames: ['status'],
      registers: [registry],
    }),
    reconciliationDiscrepancies: new Counter({
      name: 'gateway_reconciliation_discrepancies_total',
      help: 'Reconciliation discrepancies recorded, by kind.',
      labelNames: ['kind'],
      registers: [registry],
    }),
    reconciliationOpenDiscrepancies: new Gauge({
      name: 'gateway_reconciliation_open_discrepancies',
      help: 'Reconciliation discrepancies with no resolution yet, as of the most recent collection tick.',
      registers: [registry],
    }),
    rpcFailures: new Counter({
      name: 'gateway_monitor_rpc_failures_total',
      help: 'Blockchain adapter calls that threw, by network and method.',
      labelNames: ['network', 'method'],
      registers: [registry],
    }),
    signingFailures: new Counter({
      name: 'gateway_signing_failures_total',
      help: 'Signing requests that failed policy validation or the signing backend, by stage.',
      labelNames: ['stage'],
      registers: [registry],
    }),
    paymentsProcessed: new Counter({
      name: 'gateway_payments_processed_total',
      help: 'Invoices that reached a final, ledger-credited payment outcome.',
      registers: [registry],
    }),
  };
}
