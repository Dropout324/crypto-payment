# ADR 0007 - The monitor settles an invoice from its confirmed transfers, not one "the" transaction

Status: Accepted
Date: 2026-09-09

## Context

SPEC section 6 lists `transaction_hash` and `confirmation_count` as singular
fields on an invoice, which reads as "one settling transaction per invoice."
Reality (and SPEC sections 12-13) is messier: a customer can send an initial
underpayment and a top-up in a second transaction, or overpay by sending
twice. The confirmation engine (`apps/blockchain-monitor`) has to decide what
"the invoice is paid" means when more than one transfer contributed.

## Decision

`MonitorService.finalizeInvoice` sums every transfer matched to the invoice
that has independently reached `invoice.required_confirmations`, and
evaluates THAT total against what the invoice asked for
(`@gateway/payments`'s `evaluatePayment`). Only once a transfer's own
confirmations cross the threshold does it enter the sum - a transfer sitting
at 1/12 confirmations never masks whether the invoice is really settled.

The invoice's `confirmation_count` column is populated from the
highest-confirmation contributing transfer (the one closest to being final),
and `received_amount`/`confirmed_amount` are the summed total - not a single
transaction's amount. `transaction_hash` in the public API response
(`invoices.mapper.ts`) resolves to the most recent CREDITED transfer, which
is accurate for the common single-transfer case and at least informative,
not misleading, for the multi-transfer one.

Crediting happens per-transfer: each contributing transfer gets its own
`ledger_transactions` row via `postPaymentCredit`, keyed by
`credit:<network>:<tx_hash>:<transfer_index>`. Two transfers funding one
invoice produce two balanced ledger postings, not one - which is what makes
replaying either transfer's detection idempotent independent of the other.

## Consequences

* An invoice can be marked PAID by a combination of transfers, and the ledger
  correctly shows two (or more) postings for it - `SUM(ledger_entries)` for
  that invoice's `merchant_payable` account is still the source of truth,
  never a single row.
* A merchant reading `transaction_hash` off the invoice for a multi-transfer
  payment sees only the latest one. The full picture is
  `GET /v1/transactions/:hash` per transfer (Phase 5+ dashboard work) or the
  `token_transfers` table directly - documented as a known gap, not silently
  wrong.
* Underpayment top-ups and (auto-accepted) overpayment excess are both
  handled by this same summing logic - no separate code path was needed for
  "a second transfer arrived," which was the point of designing it this way
  rather than around one primary transaction.
