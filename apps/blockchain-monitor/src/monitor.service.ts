import type { BlockchainAdapter, ChainTransaction, ParsedTransfer } from '@gateway/blockchain';
import {
  type DatabaseClient,
  type Network,
  Prisma,
  type TransactionClient,
  decimalToUnits,
  runInTransaction,
  unitsToDecimal,
} from '@gateway/database';
import { postPaymentCredit } from '@gateway/ledger';
import type { FinancialMetrics } from '@gateway/observability';
import { InvoiceStatus, type InvoiceStatusValue, Money, TransferMatchStatus, newId } from '@gateway/shared';
import {
  TransitionActor,
  assertTransition,
  canTransition,
  effectiveConfirmations,
  evaluatePayment,
  evaluateTransferMatch,
  isConfirmed,
  isWithinGrace,
  statusForOutcome,
  webhookEventForStatus,
} from '@gateway/payments';
import { resolveTransferAsset } from './asset-resolver.js';

/**
 * Orchestrates the payment-detection pipeline (SPEC sections 9-14):
 *
 *   detect transfer -> match to invoice -> track confirmations ->
 *   evaluate under/over/exact -> transition invoice -> post ledger credit
 *
 * Depends only on the `BlockchainAdapter` interface (ADR 0004), so every
 * method here is exercised in tests against `FakeBlockchainAdapter` and is
 * expected to work unchanged against a real RPC-backed adapter once one
 * exists - nothing below is fake-adapter-specific.
 *
 * SPEC section 9's resilience requirements this class embodies:
 *  - a stream/poll event is NEVER trusted by itself - `processTransaction`
 *    always re-fetches the transaction and its transfers from the adapter;
 *  - every write is idempotent - re-processing the same transaction or
 *    re-running confirmation updates changes nothing that was already final;
 *  - a reorg is handled explicitly (`handleReorg`), never silently ignored.
 */
export class MonitorService {
  constructor(
    private readonly db: DatabaseClient,
    /** Seconds of grace after expiry during which a late arrival is still distinguishable from routine noise. */
    private readonly lateArrivalGraceSeconds = 120,
    /** Optional (defaults to unset in every existing test/caller): records payment latency and processed-count metrics (Phase 16/C6). */
    private readonly metrics?: FinancialMetrics,
  ) {}

  // ---------------------------------------------------------------------
  // Detection + matching
  // ---------------------------------------------------------------------

  /**
   * Fetches `txHash` fresh from the adapter (never trusts a caller-supplied
   * snapshot) and records every relevant transfer it contains. Safe to call
   * repeatedly for the same hash - matching and recording are idempotent.
   */
  async processTransaction(adapter: BlockchainAdapter, network: Network, txHash: string): Promise<void> {
    const chainTx = await adapter.getTransaction(txHash);
    if (!chainTx) return; // not (yet) known to the adapter - nothing to record

    const transfers = await adapter.getTransfers(txHash);
    if (transfers.length === 0) return;

    await runInTransaction(this.db, async (tx) => {
      const blockchainTransactionId = await this.recordChainTransaction(tx, network, chainTx);
      for (const transfer of transfers) {
        await this.recordTransfer(tx, network, blockchainTransactionId, chainTx, transfer);
      }
    });
  }

  private async recordChainTransaction(tx: TransactionClient, network: Network, chainTx: ChainTransaction): Promise<string> {
    const status = chainTx.status === 'REVERTED' ? 'REVERTED' : chainTx.blockNumber === null ? 'MEMPOOL' : 'MINED';

    const existing = await tx.blockchainTransaction.findUnique({ where: { network_txHash: { network, txHash: chainTx.hash } } });
    if (existing) {
      await tx.blockchainTransaction.update({
        where: { id: existing.id },
        data: {
          status,
          blockNumber: chainTx.blockNumber,
          blockHash: chainTx.blockHash,
          confirmations: chainTx.confirmations,
          minedAt: chainTx.blockNumber !== null ? (existing.minedAt ?? new Date()) : null,
        },
      });
      return existing.id;
    }

    const created = await tx.blockchainTransaction.create({
      data: {
        id: newId('blockchainTransaction'),
        network,
        txHash: chainTx.hash,
        status,
        blockNumber: chainTx.blockNumber,
        blockHash: chainTx.blockHash,
        fromAddress: chainTx.fromAddress,
        toAddress: chainTx.toAddress,
        feeAmount: chainTx.feeAmount === null ? null : unitsToDecimal(chainTx.feeAmount),
        confirmations: chainTx.confirmations,
        minedAt: chainTx.blockNumber !== null ? new Date() : null,
      },
    });
    return created.id;
  }

  private async recordTransfer(
    tx: TransactionClient,
    network: Network,
    blockchainTransactionId: string,
    chainTx: ChainTransaction,
    transfer: ParsedTransfer,
  ): Promise<void> {
    const existingTransfer = await tx.tokenTransfer.findUnique({
      where: { network_txHash_transferIndex: { network, txHash: chainTx.hash, transferIndex: transfer.transferIndex } },
    });
    // Idempotent replay: a credited transfer's classification never changes,
    // no matter how many times the block is rescanned.
    if (existingTransfer?.creditedAt) return;

    const asset = resolveTransferAsset(network, transfer.tokenContract);
    const assetRecognized = asset !== null;
    const meetsMinimum = asset !== null && transfer.amount >= asset.minDepositUnits;

    const address = await tx.paymentAddress.findUnique({
      where: { network_addressNormalized: { network, addressNormalized: transfer.toAddress } },
    });

    const invoice = address?.invoiceId ? await tx.invoice.findUnique({ where: { id: address.invoiceId } }) : null;
    // The invoice's `status` column may still read PENDING even after its
    // deadline (lazy expiry only fires when the API reads it - see the known
    // limitation in the README) - so expiry is judged against `expiresAt`
    // directly, not trusted from the status.
    const invoiceExpired = invoice ? !isWithinGrace(invoice.expiresAt, new Date(), this.lateArrivalGraceSeconds) : false;

    const decision = evaluateTransferMatch({
      assetRecognized,
      meetsMinimum,
      txStatus: chainTx.status,
      invoiceStatus: (invoice?.status as InvoiceStatusValue | undefined) ?? null,
      invoiceExpired,
      alreadyCredited: false,
      complianceHold: false,
    });

    const data = {
      network,
      txHash: chainTx.hash,
      transferIndex: transfer.transferIndex,
      tokenContract: transfer.tokenContract,
      assetSymbol: asset?.symbol ?? 'UNKNOWN',
      assetDecimals: asset?.decimals ?? 0,
      amount: unitsToDecimal(transfer.amount),
      fromAddress: transfer.fromAddress,
      toAddress: transfer.toAddress,
      toAddressNormalized: transfer.toAddress,
      paymentAddressId: address?.id ?? null,
      invoiceId: invoice?.id ?? null,
      matchStatus: decision.status,
      matchReason: decision.reason,
      confirmations: chainTx.confirmations,
    };

    if (existingTransfer) {
      await tx.tokenTransfer.update({ where: { id: existingTransfer.id }, data });
    } else {
      await tx.tokenTransfer.create({
        data: { id: newId('tokenTransfer'), transactionId: blockchainTransactionId, ...data },
      });
    }

    if (invoice && decision.status === TransferMatchStatus.PENDING_CONFIRMATION) {
      await this.advanceOnFirstSighting(tx, invoice.id, invoice.status as InvoiceStatusValue, invoice.createdAt);
    }

    if (invoice && decision.status === TransferMatchStatus.LATE_PAYMENT_REVIEW) {
      await this.moveToLatePaymentReview(tx, invoice.id, invoice.status as InvoiceStatusValue);
    }
  }

  /** PENDING -> DETECTED the first time a matching transfer appears; a no-op if already past that point. */
  private async advanceOnFirstSighting(
    tx: TransactionClient,
    invoiceId: string,
    currentStatus: InvoiceStatusValue,
    invoiceCreatedAt: Date,
  ): Promise<void> {
    if (!canTransition(currentStatus, InvoiceStatus.DETECTED)) return;

    assertTransition(currentStatus, InvoiceStatus.DETECTED, TransitionActor.MONITOR);
    await tx.invoice.update({
      where: { id: invoiceId },
      data: { status: InvoiceStatus.DETECTED, detectedAt: new Date(), version: { increment: 1 } },
    });
    await this.recordEvent(tx, invoiceId, 'transfer.detected', currentStatus, InvoiceStatus.DETECTED, 'monitor');
    await this.emitWebhook(tx, invoiceId, InvoiceStatus.DETECTED);
    this.metrics?.paymentDetectionLatencySeconds.observe((Date.now() - invoiceCreatedAt.getTime()) / 1000);
  }

  private async moveToLatePaymentReview(tx: TransactionClient, invoiceId: string, currentStatus: InvoiceStatusValue): Promise<void> {
    if (!canTransition(currentStatus, InvoiceStatus.LATE_PAYMENT_REVIEW)) return;
    assertTransition(currentStatus, InvoiceStatus.LATE_PAYMENT_REVIEW, TransitionActor.MONITOR);
    await tx.invoice.update({
      where: { id: invoiceId },
      data: { status: InvoiceStatus.LATE_PAYMENT_REVIEW, version: { increment: 1 } },
    });
    await this.recordEvent(tx, invoiceId, 'payment.late_arrival', currentStatus, InvoiceStatus.LATE_PAYMENT_REVIEW, 'monitor');
  }

  // ---------------------------------------------------------------------
  // Confirmation engine
  // ---------------------------------------------------------------------

  /**
   * Re-checks confirmations for every transfer still awaiting them and
   * advances (or finalises) the invoices they belong to. Idempotent: calling
   * this again with unchanged chain state changes nothing.
   */
  async updateConfirmations(adapter: BlockchainAdapter, network: Network): Promise<void> {
    const pending = await this.db.tokenTransfer.findMany({
      where: { network, matchStatus: TransferMatchStatus.PENDING_CONFIRMATION, creditedAt: null },
    });

    for (const transfer of pending) {
      const info = await adapter.getConfirmations(transfer.txHash);

      await runInTransaction(this.db, async (tx) => {
        await tx.tokenTransfer.update({ where: { id: transfer.id }, data: { confirmations: info.confirmations } });
        if (!transfer.invoiceId) return;

        const invoice = await tx.invoice.findUniqueOrThrow({ where: { id: transfer.invoiceId as string } });
        await this.advanceConfirming(tx, invoice, info.confirmations);

        const requiredConfirmations = invoice.requiredConfirmations;
        if (isConfirmed(info.confirmations, effectiveConfirmations(requiredConfirmations))) {
          await this.finalizeInvoice(tx, invoice.id);
        }
      });
    }
  }

  /** DETECTED -> CONFIRMING once the transfer has at least one confirmation and hasn't finalised yet. */
  private async advanceConfirming(tx: TransactionClient, invoice: { id: string; status: string }, confirmations: number): Promise<void> {
    if (confirmations < 1) return;
    const status = invoice.status as InvoiceStatusValue;
    if (!canTransition(status, InvoiceStatus.CONFIRMING)) return;

    assertTransition(status, InvoiceStatus.CONFIRMING, TransitionActor.MONITOR);
    await tx.invoice.update({ where: { id: invoice.id }, data: { status: InvoiceStatus.CONFIRMING, version: { increment: 1 } } });
    await this.recordEvent(tx, invoice.id, 'confirmation.started', status, InvoiceStatus.CONFIRMING, 'monitor');
    await this.emitWebhook(tx, invoice.id, InvoiceStatus.CONFIRMING);
  }

  /**
   * Once a transfer has reached the required confirmations: sum every
   * transfer matched to this invoice that has ALSO reached its own
   * confirmation threshold, evaluate that total against what the invoice
   * asked for, and settle - crediting the ledger only when the outcome
   * lands on PAID (directly, or via a merchant policy that auto-accepts an
   * under/overpayment).
   */
  private async finalizeInvoice(tx: TransactionClient, invoiceId: string): Promise<void> {
    const invoice = await tx.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
    if (!canTransition(invoice.status as InvoiceStatusValue, InvoiceStatus.PAID) &&
        !canTransition(invoice.status as InvoiceStatusValue, InvoiceStatus.UNDERPAID) &&
        !canTransition(invoice.status as InvoiceStatusValue, InvoiceStatus.OVERPAID)) {
      return; // already finalised or otherwise not eligible - idempotent no-op
    }

    const confirmedTransfers = await tx.tokenTransfer.findMany({
      where: {
        invoiceId,
        OR: [{ matchStatus: TransferMatchStatus.CREDITED }, { matchStatus: TransferMatchStatus.PENDING_CONFIRMATION }],
      },
    });

    const confirmedTotal = confirmedTransfers
      .filter((t) => t.confirmations >= invoice.requiredConfirmations)
      .reduce((sum, t) => sum + decimalToUnits(t.amount), 0n);
    if (confirmedTotal === 0n) return;

    const merchant = await tx.merchant.findUniqueOrThrow({ where: { id: invoice.merchantId } });
    const required = Money.fromUnits(decimalToUnits(invoice.cryptoAmount), invoice.paymentAsset, invoice.paymentDecimals);
    const received = Money.fromUnits(confirmedTotal, invoice.paymentAsset, invoice.paymentDecimals);

    const evaluation = evaluatePayment({
      required,
      received,
      underpaymentToleranceBps: invoice.underpaymentToleranceBps,
      overpaymentToleranceBps: invoice.overpaymentToleranceBps,
    });
    const target = statusForOutcome(evaluation.outcome);
    if (!target) return;

    const fromStatus = invoice.status as InvoiceStatusValue;
    if (!canTransition(fromStatus, target)) return;

    assertTransition(fromStatus, target, TransitionActor.MONITOR);
    await tx.invoice.update({
      where: { id: invoiceId },
      data: {
        status: target,
        receivedAmount: unitsToDecimal(confirmedTotal),
        confirmedAmount: unitsToDecimal(confirmedTotal),
        confirmationCount: Math.max(...confirmedTransfers.map((t) => t.confirmations)),
      },
    });
    await this.recordEvent(tx, invoiceId, `payment.${target.toLowerCase()}`, fromStatus, target, 'monitor');
    await this.emitWebhook(tx, invoiceId, target);
    if (invoice.detectedAt) {
      this.metrics?.paymentConfirmationLatencySeconds.observe((Date.now() - invoice.detectedAt.getTime()) / 1000);
    }

    const autoAccept =
      target === InvoiceStatus.PAID ||
      (target === InvoiceStatus.OVERPAID && merchant.overpaymentPolicy === 'ACCEPT_FULL') ||
      (target === InvoiceStatus.UNDERPAID && merchant.underpaymentPolicy === 'ACCEPT_PARTIAL');

    if (!autoAccept) return;

    if (target !== InvoiceStatus.PAID) {
      // Merchant policy auto-accepts the discrepancy: land on PAID too.
      assertTransition(target, InvoiceStatus.PAID, TransitionActor.MONITOR);
      await tx.invoice.update({ where: { id: invoiceId }, data: { status: InvoiceStatus.PAID, paidAt: new Date() } });
      await this.recordEvent(tx, invoiceId, 'payment.paid', target, InvoiceStatus.PAID, 'monitor', {
        acceptedVia: target === InvoiceStatus.OVERPAID ? 'overpayment_policy:ACCEPT_FULL' : 'underpayment_policy:ACCEPT_PARTIAL',
      });
      await this.emitWebhook(tx, invoiceId, InvoiceStatus.PAID);
    } else {
      await tx.invoice.update({ where: { id: invoiceId }, data: { paidAt: new Date() } });
    }
    this.metrics?.paymentsProcessed.inc();

    for (const transfer of confirmedTransfers.filter((t) => t.confirmations >= invoice.requiredConfirmations)) {
      const result = await postPaymentCredit(tx, {
        merchantId: invoice.merchantId,
        invoiceId,
        tokenTransferId: transfer.id,
        network: invoice.network,
        assetSymbol: invoice.paymentAsset,
        assetDecimals: invoice.paymentDecimals,
        grossAmount: Money.fromUnits(decimalToUnits(transfer.amount), invoice.paymentAsset, invoice.paymentDecimals),
        feeBps: merchant.feeBps,
        idempotencyKey: `credit:${transfer.network}:${transfer.txHash}:${transfer.transferIndex}`,
      });
      if (!result.alreadyPosted) {
        await tx.tokenTransfer.update({ where: { id: transfer.id }, data: { matchStatus: TransferMatchStatus.CREDITED, creditedAt: new Date() } });
      }
    }
  }

  // ---------------------------------------------------------------------
  // Reorg handling
  // ---------------------------------------------------------------------

  /**
   * A block at or above `fromBlock` on `network` was reorganised away.
   * Every transaction that WAS mined there is orphaned; transfers that had
   * not yet been credited simply revert their invoice, but a transfer that
   * had ALREADY been credited (the invoice was already PAID/UNDERPAID/
   * OVERPAID and the ledger already posted) is never silently reversed - it
   * goes to RECONCILIATION_REQUIRED with a discrepancy recorded, per SPEC
   * section 21.
   */
  async handleReorg(network: Network, fromBlock: bigint): Promise<void> {
    const orphanedTxs = await this.db.blockchainTransaction.findMany({
      where: { network, blockNumber: { gte: fromBlock }, status: { in: ['MINED', 'CONFIRMED'] } },
    });

    for (const chainTx of orphanedTxs) {
      await runInTransaction(this.db, async (tx) => {
        await tx.blockchainTransaction.update({ where: { id: chainTx.id }, data: { status: 'ORPHANED', orphanedAt: new Date() } });

        const transfers = await tx.tokenTransfer.findMany({ where: { transactionId: chainTx.id } });
        for (const transfer of transfers) {
          if (transfer.creditedAt) {
            await this.flagOrphanedCredit(tx, transfer.id, transfer.invoiceId);
            continue;
          }

          await tx.tokenTransfer.update({ where: { id: transfer.id }, data: { matchStatus: TransferMatchStatus.ORPHANED } });
          if (transfer.invoiceId) await this.revertInvoiceAfterOrphan(tx, transfer.invoiceId);
        }
      });
    }
  }

  private async revertInvoiceAfterOrphan(tx: TransactionClient, invoiceId: string): Promise<void> {
    const invoice = await tx.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
    const status = invoice.status as InvoiceStatusValue;

    const remaining = await tx.tokenTransfer.count({
      where: { invoiceId, matchStatus: TransferMatchStatus.PENDING_CONFIRMATION },
    });
    const target = remaining > 0 ? InvoiceStatus.DETECTED : InvoiceStatus.PENDING;
    if (!canTransition(status, target)) return;

    assertTransition(status, target, TransitionActor.MONITOR);
    await tx.invoice.update({ where: { id: invoiceId }, data: { status: target, version: { increment: 1 } } });
    await this.recordEvent(tx, invoiceId, 'reorg.reverted', status, target, 'monitor');
  }

  private async flagOrphanedCredit(tx: TransactionClient, transferId: string, invoiceId: string | null): Promise<void> {
    if (!invoiceId) return;
    const invoice = await tx.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
    const status = invoice.status as InvoiceStatusValue;
    if (!canTransition(status, InvoiceStatus.RECONCILIATION_REQUIRED)) return;

    assertTransition(status, InvoiceStatus.RECONCILIATION_REQUIRED, TransitionActor.MONITOR);
    await tx.invoice.update({ where: { id: invoiceId }, data: { status: InvoiceStatus.RECONCILIATION_REQUIRED, version: { increment: 1 } } });
    await this.recordEvent(tx, invoiceId, 'reorg.orphaned_credit', status, InvoiceStatus.RECONCILIATION_REQUIRED, 'monitor');

    const runId = newId('reconciliation');
    await tx.reconciliationRun.create({
      data: { id: runId, network: undefined, scope: 'chain_vs_db', status: 'DISCREPANCIES_FOUND', periodStart: new Date(), periodEnd: new Date(), checkedCount: 1, discrepancyCount: 1, completedAt: new Date() },
    });
    await tx.reconciliationDiscrepancy.create({
      data: {
        id: newId('reconciliation'),
        runId,
        kind: 'ORPHANED_CREDIT',
        severity: 'CRITICAL',
        subjectType: 'token_transfer',
        subjectId: transferId,
        details: { invoiceId, reason: 'crediting transaction was orphaned by a chain reorganisation' },
      },
    });
    this.metrics?.reconciliationDiscrepancies.inc({ kind: 'ORPHANED_CREDIT' });
  }

  // ---------------------------------------------------------------------
  // Shared helpers
  // ---------------------------------------------------------------------

  private async recordEvent(
    tx: TransactionClient,
    invoiceId: string,
    type: string,
    fromStatus: InvoiceStatusValue,
    toStatus: InvoiceStatusValue,
    actor: string,
    payload: Record<string, unknown> = {},
  ): Promise<void> {
    const nextSequence = (await tx.paymentEvent.count({ where: { invoiceId } })) + 1;
    await tx.paymentEvent.create({
      data: {
        id: newId('paymentEvent'),
        invoiceId,
        type,
        fromStatus,
        toStatus,
        sequence: nextSequence,
        actor,
        payload: payload as Prisma.InputJsonValue,
      },
    });
  }

  private async emitWebhook(tx: TransactionClient, invoiceId: string, status: InvoiceStatusValue): Promise<void> {
    const eventType = webhookEventForStatus(status);
    if (!eventType) return;

    const invoice = await tx.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
    await tx.webhookEvent.upsert({
      where: { idempotencyKey: `${eventType}:${invoiceId}` },
      update: {},
      create: {
        id: newId('webhookEvent'),
        merchantId: invoice.merchantId,
        invoiceId,
        type: eventType,
        idempotencyKey: `${eventType}:${invoiceId}`,
        payload: { event: eventType, data: { invoice_id: invoiceId, order_id: invoice.orderId } },
      },
    });
  }
}
