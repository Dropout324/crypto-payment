# ADR 0001 - Money is represented as integer smallest units

Status: Accepted
Date: 2026-09-08

## Context

The gateway prices invoices in fiat and collects them in crypto. Assets differ
in precision: BTC has 8 decimals, USDT on Ethereum has 6, USDT on BSC has 18,
ETH has 18. A single mis-scaled value is a financial loss, not a display bug.

JavaScript `number` is IEEE-754 double precision. It cannot represent 0.1
exactly, and it loses integer precision above 2^53 - which 1 ETH (10^18 wei)
exceeds by three orders of magnitude.

## Decision

Every monetary value is a `bigint` count of the asset's smallest indivisible
unit, from the RPC response through to the database column.

* In TypeScript: `bigint`, wrapped in the `Money` value object from
  `@gateway/shared`, which carries the asset symbol and decimal precision with
  the amount so mismatched assets cannot be combined.
* In PostgreSQL: `NUMERIC(78, 0)`. 78 digits covers `uint256`; scale 0 makes a
  fractional value impossible to store.
* At the API boundary: decimal STRINGS, never JSON numbers, parsed with
  `parseUnits` which rejects excess precision instead of truncating it.

Division always names its rounding mode. Invoice pricing rounds UP, so a
customer can never satisfy a 100.00 USD invoice with 99.999999 USD of crypto.

## Consequences

* All arithmetic is exact and deterministic; the same inputs always produce the
  same result on any machine.
* Percentages (fees, tolerances) are expressed in basis points and applied as
  an integer ratio, never as a float multiplication.
* Reading a monetary column goes through `decimalToUnits`, which throws if the
  stored value is not a whole number - a loud failure if anything ever writes a
  float.
* JSON cannot carry `bigint`, so serialisation emits strings. Clients that
  parse with `JSON.parse` into `number` will lose precision; the API docs must
  say so explicitly.
