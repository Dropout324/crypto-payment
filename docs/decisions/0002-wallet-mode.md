# ADR 0002 - Merchant-controlled wallets first, custodial second

Status: Accepted
Date: 2026-09-08

## Context

SPEC section 7 requires both architectures:

* Mode A, custodial: the gateway derives and controls deposit addresses, and
  can therefore move funds - which makes it a money transmitter in most
  jurisdictions and a high-value target.
* Mode B, merchant-controlled: the merchant supplies destination addresses; the
  gateway only watches the chain and reports what it sees.

Both must be supported, but one has to be implemented and hardened first.

## Decision

Mode B (`MERCHANT_CONTROLLED`) is the default for new merchants and the mode
implemented first. Mode A is designed for from the start - the schema carries
`wallets`, `wallet_accounts`, derivation paths and a `signing_key_ref` - but no
private key material exists anywhere in this system until the signing service
of Phase 8 is built.

## Rationale

* The failure mode of a bug in Mode B is a wrong number on a dashboard. The
  failure mode in Mode A is stolen customer funds.
* Custody triggers licensing, capital and audit obligations that vary by
  jurisdiction. Building the watch-only path first lets the product be useful
  before those are resolved, rather than after.
* Everything hard about the payment path - detection, confirmations, reorgs,
  underpayment, idempotency, the ledger - is identical in both modes. Mode A
  adds key management on top of a proven base rather than alongside an unproven
  one.

## Consequences

* `Wallet.extendedPublicKey` stores an extended PUBLIC key only. A private key
  or seed phrase must never appear in this database, in a log, or in an
  environment variable.
* In Mode B the ledger still records `merchant_holdings` so the books balance,
  even though the gateway cannot move those funds.
* Address reuse is a real risk in Mode B: a merchant may supply one address for
  many invoices. Matching therefore cannot rely on "one address, one invoice";
  the amount and time window participate in the match, and ambiguous receipts
  go to manual review rather than being guessed at.
* Mode A remains blocked on a KMS/HSM-backed signing service with policy
  controls (allowed destinations, amount ceilings, rate limits, approvals).
