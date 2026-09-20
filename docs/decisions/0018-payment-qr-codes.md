# ADR 0018 - Scannable payment QR codes: BIP-21/EIP-681 built server-side, rendered client-side

Status: Accepted
Date: 2026-09-10

## Context

The hosted payment page (`/pay/[invoiceId]`, Phase 7) showed a deposit
address as plain text - a payer had to copy it and type the amount into
their wallet by hand. Writing the E2E suite for that page (ADR 0017) made
this gap obvious in practice, not just on paper: nothing on the page was
actually a *payment*, only a *destination*. This ADR adds a scannable QR
code carrying both the address and the amount.

## Decisions

### The URI is built server-side, in `packages/shared`, not in `apps/web`

`apps/web` has zero workspace dependencies on this monorepo's own packages
today - it only ever talks to `apps/api` over HTTP and hand-duplicates the
response shapes it needs in `lib/types.ts`. Building a correct payment URI
needs three pieces of chain-specific knowledge that already live in
`packages/shared` and nowhere else: a network's EVM chain id
(`NETWORKS[...].chainId`), an asset's decimals, and its ERC-20 contract
address when it has one (`findAsset`). Duplicating that table into
`apps/web` would create a second copy of the exact kind of per-chain
constant this codebase has been careful to keep in one place since ADR 0001
(money) and the asset allowlist's own comment ("only the contract ADDRESS
is authoritative"). Instead, `packages/shared/src/domain/payment-uri.ts`
exports `buildPaymentUri(network, assetSymbol, address, amountDecimal)`,
and `apps/api`'s invoice mapper (`invoices.mapper.ts`) calls it once and
adds the result as `payment_uri` on both `InvoiceResponse` and
`PublicInvoiceResponse`. `apps/web` never sees a chain id or a contract
address - it receives a ready string and hands it to a QR component.

### Two URI schemes, chosen by network family; asset, not just network, decides EVM's shape

* **Bitcoin** (`family: 'bitcoin'`): BIP-21 - `bitcoin:<address>?amount=<BTC>`.
* **EVM** (`family: 'evm'`): EIP-681. A native-coin invoice (ETH, BNB, POL -
  `asset.contractAddress === null`) produces a `value=`-bearing URI against
  the deposit address itself. A token invoice (USDT, USDC) produces the
  function-call form against the **token's contract address**, with the
  deposit address and amount as the `address`/`uint256` call arguments -
  scanning a token QR must not point a wallet at sending native ETH/BNB/POL
  straight to the deposit address, which would arrive as the wrong asset
  entirely.

`buildPaymentUri` intentionally does not fall back from an unresolvable
asset symbol to the network's native asset (an earlier draft did, and a
test written for the "unknown asset" case caught it immediately - see
`packages/shared/test/payment-uri.test.ts`): every real caller already
passes an invoice's already-validated `payment_asset`, so a symbol that
does not resolve indicates a bug upstream, not "assume they meant ETH".
Silently substituting the native asset there would point a QR at the wrong
asset with no error anywhere.

### The frontend falls back to the bare address, never to nothing

`payment_uri` is `null` whenever there is no address yet, or for a
network/asset this function doesn't cover (there is no Bitcoin
`addressModel` case beyond the one BIP-21 branch already handles, but the
`evm` branch's `chainId === null` guard exists for exactly this kind of
future gap). `PaymentStatus.tsx` renders
`<QRCode value={invoice.payment_uri ?? invoice.payment_address} />`: a
payer can always scan *something* usable - worst case, the bare address,
same as before this ADR - rather than the QR block disappearing outright
over a gap in `payment_uri` coverage.

### `react-qr-code`: one small SVG component, no other choice evaluated in depth

It has no runtime dependencies, renders an SVG (crisp at any size, unlike a
canvas/raster QR), and its only peer dependency is `react` itself - a good
fit for a page that otherwise carries almost no client-side bundle weight.
The QR is always rendered on a fixed white background regardless of the
dashboard's dark theme: QR scanners need real light/dark contrast, and
"theming" a QR code to match a dark page is a common way to make it stop
scanning reliably.

## Consequences

* `InvoiceResponse` and `PublicInvoiceResponse` both gained `payment_uri:
  string | null`. Existing `apps/api` e2e tests use `toMatchObject`
  (partial matching), so none needed updating; `packages/shared/test/payment-uri.test.ts`
  covers the new function directly (Bitcoin, EVM native, EVM token,
  testnet-vs-mainnet chain id, unresolvable-asset).
* `apps/web/e2e/public-pay.spec.ts` (ADR 0017) now also asserts the QR
  renders for a freshly created invoice - the same suite that made the
  missing-QR gap visible in the first place now guards against it
  regressing.
* Fixed, in passing, a pre-existing bug this feature's manual verification
  surfaced in the same component: `PaymentStatus.tsx`'s expiry line used
  `Date.toLocaleString()` with no explicit locale, which formats
  differently on the Node server than in the payer's browser and threw a
  React hydration error on every load (silently "fixed" itself by
  discarding and re-rendering the component client-side, which is not the
  same as not having the bug). Pinned to `toLocaleString('en-US', {
  timeZone: 'UTC', ... })` so server and client always agree.
* Not done: no on-page "copy address" button, no wallet deep-link
  (`window.location = paymentUri`) for a mobile payer opening the page
  directly in their wallet's browser rather than scanning with a second
  device - both are natural follow-ups but outside what was asked for here.
