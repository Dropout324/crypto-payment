import { InvoiceStatus, TransferMatchStatus } from '@gateway/shared';
import { describe, expect, it } from 'vitest';
import { evaluateTransferMatch, type MatchInput } from '../src/matcher.js';

const baseInput: MatchInput = {
  assetRecognized: true,
  meetsMinimum: true,
  txStatus: 'SUCCESS',
  invoiceStatus: InvoiceStatus.PENDING,
  invoiceExpired: false,
  alreadyCredited: false,
  complianceHold: false,
};

describe('evaluateTransferMatch: idempotency comes first', () => {
  it('reports CREDITED for an already-credited transfer regardless of anything else', () => {
    const decision = evaluateTransferMatch({
      ...baseInput,
      alreadyCredited: true,
      txStatus: 'REVERTED', // even a nonsensical combination
      assetRecognized: false,
    });
    expect(decision.status).toBe(TransferMatchStatus.CREDITED);
  });
});

describe('evaluateTransferMatch: chain-level rejects', () => {
  it('rejects a reverted transaction', () => {
    const decision = evaluateTransferMatch({ ...baseInput, txStatus: 'REVERTED' });
    expect(decision.status).toBe(TransferMatchStatus.UNMATCHED);
  });

  it('flags an unrecognised asset before checking anything invoice-related', () => {
    const decision = evaluateTransferMatch({ ...baseInput, assetRecognized: false, invoiceStatus: null });
    expect(decision.status).toBe(TransferMatchStatus.UNSUPPORTED_ASSET);
  });

  it('flags a below-minimum (dust) transfer', () => {
    const decision = evaluateTransferMatch({ ...baseInput, meetsMinimum: false });
    expect(decision.status).toBe(TransferMatchStatus.BELOW_MINIMUM);
  });
});

describe('evaluateTransferMatch: compliance', () => {
  it('holds a transfer flagged by compliance ahead of invoice matching', () => {
    const decision = evaluateTransferMatch({ ...baseInput, complianceHold: true, invoiceStatus: null });
    expect(decision.status).toBe(TransferMatchStatus.COMPLIANCE_HOLD);
  });
});

describe('evaluateTransferMatch: invoice matching', () => {
  it('reports UNMATCHED when the address is ours but no invoice claims it', () => {
    const decision = evaluateTransferMatch({ ...baseInput, invoiceStatus: null });
    expect(decision.status).toBe(TransferMatchStatus.UNMATCHED);
  });

  it('matches a payable invoice for confirmation', () => {
    const decision = evaluateTransferMatch({ ...baseInput, invoiceStatus: InvoiceStatus.PENDING });
    expect(decision.status).toBe(TransferMatchStatus.PENDING_CONFIRMATION);
  });

  it('matches an UNDERPAID invoice awaiting a top-up', () => {
    const decision = evaluateTransferMatch({ ...baseInput, invoiceStatus: InvoiceStatus.UNDERPAID });
    expect(decision.status).toBe(TransferMatchStatus.PENDING_CONFIRMATION);
  });

  it('sends a payment for an expired invoice to late-payment review, never silently drops it', () => {
    const decision = evaluateTransferMatch({ ...baseInput, invoiceStatus: InvoiceStatus.PENDING, invoiceExpired: true });
    expect(decision.status).toBe(TransferMatchStatus.LATE_PAYMENT_REVIEW);
  });

  it('sends a payment for a cancelled invoice to late-payment review', () => {
    const decision = evaluateTransferMatch({ ...baseInput, invoiceStatus: InvoiceStatus.CANCELLED });
    expect(decision.status).toBe(TransferMatchStatus.LATE_PAYMENT_REVIEW);
  });

  it('sends a payment for an already-PAID invoice to late-payment review, not a second credit', () => {
    const decision = evaluateTransferMatch({ ...baseInput, invoiceStatus: InvoiceStatus.PAID });
    expect(decision.status).toBe(TransferMatchStatus.LATE_PAYMENT_REVIEW);
  });

  it('never matches a non-payable status as PENDING_CONFIRMATION', () => {
    const nonPayable = [
      InvoiceStatus.CREATED,
      InvoiceStatus.PAID,
      InvoiceStatus.OVERPAID,
      InvoiceStatus.EXPIRED,
      InvoiceStatus.CANCELLED,
      InvoiceStatus.FAILED,
      InvoiceStatus.REFUNDED,
      InvoiceStatus.COMPLIANCE_REVIEW_REQUIRED,
      InvoiceStatus.LATE_PAYMENT_REVIEW,
      InvoiceStatus.RECONCILIATION_REQUIRED,
    ];
    for (const status of nonPayable) {
      const decision = evaluateTransferMatch({ ...baseInput, invoiceStatus: status });
      expect(decision.status, `status for invoice ${status}`).not.toBe(TransferMatchStatus.PENDING_CONFIRMATION);
    }
  });
});
