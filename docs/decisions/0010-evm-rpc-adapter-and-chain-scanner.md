# ADR 0010 - A concrete EVM adapter, a discovery scanner to feed it, and why the seed script no longer touches `chain_cursors`

Status: Accepted
Date: 2026-09-09

## Context

ADR 0004 deliberately built the entire payment pipeline against
`FakeBlockchainAdapter` and left "wire in a real RPC provider" as the one
piece that could not be built without credentials. With Sepolia RPC access
available, three things needed deciding: how to talk to the provider, how to
discover which transactions are worth showing to `MonitorService` at all, and
how a freshly-seeded deployment picks its starting scan position.

## Decisions

### `EvmJsonRpcAdapter` is a raw JSON-RPC client, not an ethers/viem dependency

Every call this codebase needs (`eth_getTransactionByHash`,
`eth_getTransactionReceipt`, `eth_getBlockByNumber`, `eth_blockNumber`,
`eth_getBalance`) is a flat request/response, and the response shapes are
parsed directly into this package's own `ChainTransaction` / `ParsedTransfer`
/ `BlockData` types - the same types `FakeBlockchainAdapter` already produces
and `MonitorService` already consumes. A full client library would mean
maintaining a second set of chain-shape assumptions alongside the
hand-built ones `parseTransferLog` and the EIP-55 address code already use,
for no behaviour this codebase needs that raw JSON-RPC doesn't already give
it. `EvmRpcClient` supports JSON-RPC batching (one HTTP round trip for
several calls) and a fallback URL that is tried only on a TRANSPORT failure
(timeout, network error, 5xx) - never on a JSON-RPC application error, since
a second node would answer a well-formed request the same way.

One adapter class serves Ethereum, Polygon and BSC (and their testnets):
they differ only in RPC URL and chain id, both supplied by the caller via
`NETWORKS`/`.env`, never by branching inside the adapter.

### `ChainScanner` decides what is worth showing to `MonitorService` - and how

`MonitorService.processTransaction` re-verifies AND RECORDS whatever hash it
is given, writing a `token_transfers` row for every transfer found - calling
it for chain activity unrelated to this gateway would flood that table with
noise. `ChainScanner` (`apps/blockchain-monitor/src/scanner.ts`) is the
filter: it walks newly-produced blocks and calls `getTransfers` per
transaction, handing `MonitorService` only the hashes where some transfer's
destination is a currently-tracked `payment_addresses` row (status
`ASSIGNED` or `RETIRED` - the latter because late arrivals to a closed
invoice's address still need `moveToLatePaymentReview` to see them).

One tradeoff is deliberate and documented in the scanner's own comments
rather than hidden: **reorg detection re-checks only the single
last-processed block's hash** each tick, not every block within
`reorgDepth`. A reorg deeper than one block still resolves correctly, just
over several ticks (each mismatch rewinds the cursor one further block)
instead of in one pass.

### `eth_getLogs` pre-filtering (added after the naive version hit real mainnet limits)

The first version of `ChainScanner` called `getTransfers` (which fetches a
transaction's receipt) for every transaction in every scanned block. That is
the right tradeoff for a low-volume testnet - simple, and reuses the exact
`BlockchainAdapter` interface method the monitor itself trusts - but it is
not a hypothetical scaling concern: running it against live Ethereum and BSC
mainnet during development exhausted a free RPC tier's rate limit (HTTP 429
on Alchemy, HTTP 403 on a public BSC node) within minutes, because a busy
mainnet block can hold hundreds of transactions, each needing its own
receipt fetch.

The fix adds two methods to `EvmJsonRpcAdapter` that are deliberately NOT
part of `BlockchainAdapter` (ADR 0004: every other consumer of that
interface is chain-family agnostic):

* `getLightBlock` - the same block read as `getBlock`, but WITHOUT the
  per-transaction receipt fetch, returning only what native-transfer
  discovery needs (`hash`/`to`/`value`).
* `getTransferLogsTo` - one `eth_getLogs` call across the whole scanned
  range, filtered server-side to the network's allowlisted token contracts
  and every tracked address's log topic. The provider does the filtering
  that used to happen client-side, one receipt at a time.

`ChainScanner` feature-detects these methods on whatever adapter it is
given (duck-typed, not an `instanceof` check) and uses them when present;
`FakeBlockchainAdapter` (and any future non-EVM adapter) lacks them and
falls through to the original per-transaction path, which stays correct for
any `BlockchainAdapter` - just not cheap enough for a high-volume chain.
Verified live: after this change, the same Ethereum/BSC mainnet run that
previously failed within minutes ran cleanly across multiple ticks.

### A malformed tracked address must not take down a whole network's monitoring

Building the `eth_getLogs` path surfaced a second, unrelated gap: one
corrupted row in `payment_addresses` (stray test data, 16 bytes instead of
20) made `getTransferLogsTo` throw while encoding it into a log-topic
filter - and since that address is fetched fresh every tick, the SAME
network would fail forever, not just once. `ChainScanner.loadTrackedAddresses`
now runs every address through `adapter.validateAddress` before it enters
the tracked set; a row that fails silently drops out of THIS tick's tracking
(logged nowhere yet - a bad row is a data-quality problem worth its own
alert, tracked as follow-up) rather than being retried into a permanent
outage for every merchant on that network.

Position is persisted per network in `chain_cursors`, so a restart resumes
rather than re-scanning from genesis or silently skipping blocks - and a
network scanned for the first time ever starts one block behind the current
tip, not at block zero: this gateway only needs to observe payments from the
moment it starts watching a network.

### The seed script no longer pre-creates `chain_cursors` rows

It used to, unconditionally, at `lastProcessedBlock: 0`, for every network.
Once `ChainScanner` existed to actually read that value, this stopped being
harmless: a real deployment always runs `pnpm seed`, so `ChainScanner.
loadCursor` would see an EXISTING row at block 0 and dutifully start
catching up from genesis - millions of blocks behind on any real network,
at `MONITOR_BLOCK_BATCH_SIZE` (default 50) blocks per tick. This was caught
by running the monitor against live Sepolia during development: the first
tick reported `scannedBlocks: 50` starting from block 0 instead of the
handful expected near the tip. `chain_cursors` is now left for
`ChainScanner` to create on first real use, which is the only place that
knows the right starting position.

## Consequences

* `EvmJsonRpcAdapter` is proven two ways: unit tests
  (`packages/blockchain/test/rpc-adapter.test.ts`) against a scripted fake
  `fetch`, and `rpc-adapter.live.test.ts` against the real Sepolia network -
  the latter `describe.skipIf`s cleanly when `ETHEREUM_SEPOLIA_RPC_URL` is
  unset, unlike the local-database tests, which fail rather than skip
  (a third-party network dependency is not something every dev machine or CI
  run can be expected to have; Postgres is, since this project provisions it
  for every contributor).
* `ChainScanner` is proven against `FakeBlockchainAdapter`
  (`apps/blockchain-monitor/test/scanner.test.ts`): discovery of a tracked
  transfer through to `PAID`, ignoring an untracked transfer (and never
  writing a `token_transfers` row for it), and reorg detection plus cursor
  rewind. The fast EVM path is proven separately
  (`test/scanner-fast-path.test.ts`) against a test double that THROWS if the
  scanner ever falls back to `getBlock`/`getTransfers` while the cheap
  methods are available - so a future change accidentally reintroducing the
  per-transaction receipt fetch fails a test, not just a production rate
  limit.
* `apps/blockchain-monitor/src/main.ts` runs one poll loop per EVM network
  that has an RPC URL configured in `.env`, verified live against all six
  configured networks at once (Ethereum, Polygon, BSC and their testnets)
  running concurrently without errors after the `eth_getLogs` change; an
  unconfigured network is simply absent from the loop list, matching the
  documented "leave a network's URL empty to disable its monitor" behaviour.
  Bitcoin is not wired in - it needs its own adapter (UTXO, not
  account-based; a materially different scanning strategy), tracked as
  separate work.
* This still leaves multi-block-deep reorg re-verification as a known,
  scoped gap, called out at its point of implementation in `scanner.ts`
  rather than only here.
