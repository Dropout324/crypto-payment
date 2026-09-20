# ADR 0006 - Merchant-controlled deposit addresses are a registered pool

Status: Accepted
Date: 2026-09-08

## Context

SPEC section 16 shows invoice creation returning a `payment_address` chosen by
the server, but a merchant-controlled (Mode B, ADR 0002) gateway has no key
material with which to derive one on demand. Something has to supply
addresses for the server to hand out, and SPEC section 8 forbids reusing one
address across invoices.

## Decision

`POST /v1/merchant/addresses` (not in SPEC section 15's literal list, added as
a necessary consequence of it) lets a merchant register destination addresses
into a pool. Invoice creation reserves one with:

```sql
SELECT id FROM payment_addresses
WHERE merchant_id = $1 AND network = $2 AND status = 'AVAILABLE'
  AND (asset_symbol IS NULL OR asset_symbol = $3)
ORDER BY created_at ASC
LIMIT 1
FOR UPDATE SKIP LOCKED
```

`FOR UPDATE SKIP LOCKED` inside a serializable transaction is what makes two
concurrent invoice creations each claim a different row instead of racing for
the same one (proven in `invoices.e2e.test.ts`'s "never assigns one address to
two invoices" - two concurrent requests against a one-address pool always
resolve to exactly one success and one clean `ADDRESS_POOL_EXHAUSTED`, never
both succeeding).

An address is never returned to `AVAILABLE` once assigned. Cancelling an
invoice retires its address (`RETIRED`) rather than releasing it, per SPEC
section 8's "never reuse" rule - a cancelled invoice's address may still
receive a late payment (`LATE_PAYMENT_REVIEW`), so it must keep being watched
even though it can never be assigned again.

Addresses are validated before acceptance: EIP-55 checksum validation for EVM
addresses (rejecting a mixed-case address whose checksum does not match - the
exact shape of a single-character typo), and Base58Check/Bech32/Bech32m
validation for Bitcoin, both from `packages/blockchain`.

## Consequences

* Address uniqueness (`network`, `address_normalized`) is GLOBAL across
  merchants, not merchant-scoped - a real on-chain address cannot belong to
  two different merchants' pools simultaneously, since a payment to it would
  be ambiguous. Registering an address already claimed by another merchant is
  rejected with 409.
* Running out of registered addresses is a normal, expected operational state
  (`422 address_pool_exhausted`), not a bug - a merchant must keep the pool
  stocked, and the dashboard (Phase 7) should surface pool depth.
* This endpoint is Mode B-specific. Mode A (custodial), when built in Phase 8,
  will populate the same `payment_addresses` table by HD derivation through
  the signing service instead of merchant registration - the invoice-creation
  reservation query above does not change either way.
