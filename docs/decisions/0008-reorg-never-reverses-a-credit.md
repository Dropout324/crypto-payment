# ADR 0008 - A reorg never silently reverses a posted ledger credit

Status: Accepted
Date: 2026-09-09

## Context

SPEC section 9 requires reorg handling; SPEC section 21 forbids silently
correcting a financial discrepancy. These collide exactly at one point: what
happens when the block containing an ALREADY-CREDITED transaction (the
invoice is PAID, the ledger has posted) turns out to have been reorganised
away?

Reversing the ledger entry automatically is the "obvious" fix and is exactly
what section 21 prohibits - by the time a transaction has enough
confirmations to be credited, an automatic reversal is a judgment call
(is the replacement transaction going to confirm the same payment? was this
a double-spend? should the merchant be clawed back after telling their
customer the order is paid?) that the software should not make alone.

## Decision

`MonitorService.handleReorg` branches on whether the orphaned transfer had
`credited_at` set:

* **Not yet credited** (still `PENDING_CONFIRMATION`): the invoice simply
  reverts - `CONFIRMING`/`DETECTED` back to `DETECTED`/`PENDING` per the state
  machine's reorg edges (`packages/payments/src/state-machine.ts`). This is
  routine; a transaction bouncing out of a two-block-old tip before it was
  ever relied upon is not a financial event.
* **Already credited**: the invoice moves to `RECONCILIATION_REQUIRED` (an
  edge that exists from `PAID`, `UNDERPAID`, and `OVERPAID` specifically for
  this), and a `reconciliation_discrepancies` row is written with kind
  `ORPHANED_CREDIT` and severity `CRITICAL`. The `blockchain_transactions` row
  is marked `ORPHANED`. The ledger posting itself - the `ledger_transactions`
  and `ledger_entries` rows already committed - is left completely untouched.

## Consequences

* `RECONCILIATION_REQUIRED` is a dead end for automation on purpose: nothing
  in this codebase transitions an invoice OUT of it except an admin action
  (see the state machine's `RECONCILIATION_REQUIRED` edges, all
  `TransitionActor.ADMIN`). Resolving one requires the admin dashboard (Phase
  7) or direct operator intervention, and the resolution is itself an
  auditable transition, not a database patch.
* This is deliberately conservative for a scenario (a reorg deep enough to
  undo an already-confirmed, already-credited transaction) that should be
  rare precisely because `required_confirmations` exists to make it rare. The
  cost of that conservatism is an operational alert queue item, not a
  silently wrong balance.
* Proven in `apps/blockchain-monitor/test/monitor.e2e.test.ts`'s "sends an
  already-credited invoice to RECONCILIATION_REQUIRED instead of silently
  reversing it" - the test asserts the ledger entries still exist and are
  unchanged after the reorg is processed.
