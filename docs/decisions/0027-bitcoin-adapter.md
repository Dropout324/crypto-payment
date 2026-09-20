# ADR 0027 - Bitcoin support: a UTXO `BlockchainAdapter`, proven on regtest

Status: Accepted
Date: 2026-09-12

## Context

Phase 13 (`README.md#roadmap`) picks up a network that
had, until now, only address validation (`packages/blockchain/src/address/bitcoin.ts`)
and scaffolding: a `BITCOIN`/`BITCOIN_TESTNET` `NetworkConfig` (already
carrying `family: 'bitcoin'`, `addressModel: 'utxo'`), a BTC entry in the
asset allowlist, and `ParsedTransfer.transferIndex`'s doc comment already
anticipating "Bitcoin: output (vout) index". No adapter, scanner wiring, or
end-to-end test against a real Bitcoin node existed.

This is a Tier 2 phase (`README.md#roadmap`'s Open
decision #5) - built because a working, evidenced Bitcoin path removes a
concrete objection in technical review, not because a market survey demanded
it. Nothing here changes M1/M2 gating; a non-custodial, EVM-only release
remains viable if this phase's exclusion were ever needed.

## Decisions

### `BitcoinRpcAdapter`, not a chain SDK

`packages/blockchain/src/bitcoin/rpc-adapter.ts` implements `BlockchainAdapter`
against a real Bitcoin Core (`bitcoind`) JSON-RPC node, the same posture
`EvmJsonRpcAdapter` takes toward EVM providers: no `bitcoinjs-lib`, no
`bip32`/`bip39`, nothing beyond `packages/blockchain/src/bitcoin/rpc-client.ts`'s
minimal HTTP JSON-RPC client (`packages/blockchain/package.json` gains no
new dependency). This works because Bitcoin Core's own RPC already returns
transaction outputs pre-decoded with a resolved `address` field
(`scriptPubKey.address`, or `.addresses[0]` on nodes older than v22) - there
is no script-parsing this codebase needs to own, and no HD derivation is in
scope (see "No address derivation" below).

Requires `-txindex=1` on the node, so an arbitrary transaction can be looked
up by hash (`getrawtransaction`) without a block hint - the same requirement
any indexer-free deployment of this adapter carries.

### UTXO shape: one `ParsedTransfer` per output, no `fromAddress`, no fee

A Bitcoin transaction has no single "to" address the way an EVM transaction
does. `getTransfers` returns one `ParsedTransfer` per `vout`, with
`transferIndex = vout.n` - exactly the mapping `token_transfers`' `(network,
tx_hash, transfer_index)` constraint already assumed (SPEC/schema comment,
predating this adapter). Multiple outputs paying the same deposit address in
one transaction simply produce multiple transfer rows, which
`MonitorService.finalizeInvoice` already sums correctly (it was written
adapter-agnostic - summing matched, confirmed `TokenTransfer` rows, never
assuming one row per invoice).

`fromAddress` is always `null` and `feeAmount` is always `null`. Both would
require resolving each input's previous output (`vin[].txid`/`vin[].vout` ->
another `getrawtransaction` call per input) purely for display - neither
value drives any credit decision (`postPaymentCredit` keys on the receiving
transfer and its own amount, never the sender or the fee). Cheaper to leave
both honestly `null` than to spend RPC round trips on data nothing reads.

### No revert; an unmined transaction is never a transfer

Bitcoin has no analogue of an EVM revert - once a transaction is mined it is
final unless the block itself is reorganised away, which `ChainScanner`'s
existing hash-based reorg detection already covers generically (it re-checks
the last-processed block's hash each tick, regardless of which adapter is
underneath). `toChainTransaction` maps a mined transaction's `status` to
`'SUCCESS'` and an unmined one to `'PENDING'` - there is no `'REVERTED'` path
for this adapter.

`getTransfers` returns `[]` for any transaction without a `blockhash` (i.e.
still only in the mempool), mirroring `EvmJsonRpcAdapter.getTransfers`
refusing to parse an unmined transaction. This is a deliberate safety
margin, not a strict architectural requirement: an unconfirmed transaction
can still be replaced (RBF) or simply evicted, so nothing before "mined" is
safe to treat as a real transfer. It also costs nothing in practice - the
generic scanner path (below) only ever calls `getTransfers` for hashes it
already found by walking mined blocks.

### `ChainScanner`'s existing generic path, unmodified - but `getBlock` itself needed to be cheap

`ChainScanner.scanRangeGeneric` (any `BlockchainAdapter`, one `getBlock` per
height plus one `getTransfers` per candidate transaction) works for this
adapter with zero changes to `scanner.ts` - it was written generic from the
start (`scanRangeFast`, EVM's `eth_getLogs`-based optimisation from ADR
0010, is feature-detected and simply does not apply here).

`getBlock` itself did need a real fix, though - not a hypothetical one.
The first version called `getblock` at verbosity 2 (every transaction fully
decoded), reasoned at the time to be "honest" full data rather than a
placeholder. The **live mainnet test below reproduced a real timeout**
against a real busy block (3,172 transactions) through a real hosted
provider (Alchemy) - the same class of problem ADR 0010 fixed for EVM,
just discovered by evidence here rather than assumed up front. Fixed by
switching to verbosity 1 (bare txids) and confirming, by reading
`scanner.ts`, that nothing in this codebase's generic scan path ever reads
more than `.hash` off `getBlock`'s embedded transactions before separately
calling `getTransaction`/`getTransfers` for a real candidate - so nothing
downstream regressed, and the fix cost nothing in correctness. Unlike EVM,
this did not need a second method (`getLightBlock`) alongside the real
`getBlock` - Bitcoin's `getBlock` verbosity is a single RPC parameter, not a
different call shape, so the cheap path could be folded directly into
`getBlock` itself once it was clear no caller needed the expensive one.

### `getBalance`: real, but expensive - documented, not hidden

Bitcoin Core has no indexed "balance of an arbitrary address" RPC without a
wallet import or an external indexer. `getBalance` uses `scantxoutset`,
which walks the full UTXO set on every call - correct, but not something to
call at volume. This is safe to ship as-is because `getBalance` is not on
any credit-path code in this codebase (the interface's own doc comment: "the
gateway credits from observed TRANSFERS, never from a balance snapshot"),
confirmed by grep - only adapter-level tests call it, the same as
`EvmJsonRpcAdapter.getBalance`. A production deployment watching many
Bitcoin addresses at real volume should front this with a real indexer (e.g.
Electrs) rather than call this method per address; documented on the method
itself, not just here.

### Two real, pre-existing bugs found while wiring this in

Building the first non-EVM adapter surfaced two bugs in code that had only
ever been exercised by EVM (hex, case-insensitive) addresses:

1. **`normalizeBitcoinAddress` mis-detected which addresses are
   case-sensitive.** It kept an address as-is only when it started with
   `1`/`3`/`2` (mainnet P2PKH/P2SH, testnet P2SH) and lowercased everything
   else - silently corrupting a real testnet legacy P2PKH address (prefix
   `m`/`n`), which is also case-sensitive Base58Check but was never in the
   allow-list. Caught by a real regtest round trip
   (`packages/blockchain/test/bitcoin/rpc-adapter.test.ts`: fund a legacy
   address, mine it, assert the credited transfer's `toAddress` matches the
   address exactly) - it failed until fixed. Fixed by re-running the same
   Base58Check validity check `isValidBitcoinAddress` already uses, instead
   of guessing from a leading character.
2. **`ChainScanner` unconditionally lowercased every address before
   comparing it against tracked deposit addresses**
   (`loadTrackedAddresses`/`touchesTrackedAddress`). Correct for EVM (hex is
   case-insensitive; the RPC can return checksummed mixed case), silently
   wrong for Bitcoin legacy addresses, which are case-sensitive - a
   lowercased legacy address is a different, generally invalid, address, so
   `validateAddress` would reject it and the deposit address would simply
   never be tracked. Fixed with `normalizeForTracking()`: lowercase only an
   address starting with `0x` (only ever true for EVM); leave anything else
   exactly as given. `BitcoinRpcAdapter.getTransfers` separately normalizes
   `toAddress` at the source via `normalizeBitcoinAddress` before returning
   it, matching `EvmJsonRpcAdapter`'s existing pattern of normalizing inside
   the adapter rather than leaving it to callers.

Both were real latent defects in already-shipped, already-tested code - the
existing EVM test suites could not have caught either, since every fixture
address they use is `0x`-prefixed hex.

### Test address choice: legacy, not bech32, on regtest

Every regtest test in this phase uses legacy (Base58Check) addresses, never
bech32. Regtest's bech32 human-readable part is `bcrt` (e.g.
`bcrt1q...`), which differs from real testnet's `tb` and real mainnet's
`bc` - `isValidBitcoinAddress`/`validateAddress` correctly never accept a
`bcrt1...` address under either real network kind, because the real
`BITCOIN_TESTNET`/`BITCOIN` networks this adapter is instantiated with never
produce one. This is a test-environment quirk, not a production gap:
regtest's legacy version bytes are identical to real testnet's, so legacy
addresses exercise the exact same validation and normalization path a real
testnet deployment would use. Bech32 correctness itself is already covered
independently in `packages/blockchain/test/bitcoin-address.test.ts` (real
mainnet/testnet address vectors, no regtest involved).

### Evidence: regtest, not a live third-party testnet

Unlike `rpc-adapter.live.test.ts` (skips against a real, third-party Sepolia
provider - non-deterministic, not something every run can be expected to
have), Bitcoin regtest is fully local and deterministic: the test suite
mines its own blocks and can invalidate them on demand. Two new test files,
both `describe.skipIf(!process.env.BITCOIN_REGTEST_RPC_URL)` so a
contributor or CI run without the node still passes cleanly:

* `packages/blockchain/test/bitcoin/rpc-adapter.test.ts` - adapter-level:
  chain tip, block-by-height/by-hash round trip, address validation, a real
  mined payment (`getTransaction`/`getTransfers`/`getConfirmations` all
  agree), an unconfirmed transaction credits nothing, a real balance via
  `scantxoutset`, and a real reorg (`invalidateblock`).
- `packages/blockchain/test/bitcoin/rpc-adapter.live.test.ts` - the same
  role `rpc-adapter.live.test.ts` plays for EVM: read-only checks against a
  real Bitcoin mainnet RPC provider (`BITCOIN_RPC_URL`, skips if unset).
  This is what actually caught the `getBlock` verbosity-2 timeout above -
  regtest blocks are too small to ever have reproduced it.
- `apps/blockchain-monitor/test/bitcoin-scanner.e2e.test.ts` - the same
  proof the EVM path already had via `FakeBlockchainAdapter`
  (`scanner.test.ts`, `monitor.e2e.test.ts`), but against the real adapter
  and a real node: a payment discovered and driven to `PAID` with a
  balanced, three-entry ledger credit; a real reorg detected and the cursor
  rewound; and a duplicate-transaction case - the same already-credited
  payment rescanned across further ticks credits the ledger exactly once
  (`ledgerTransaction.count(...) === 1`), satisfying the Phase 13 exit
  criteria's explicit reorg-and-duplicate-transaction requirement.

`docker-compose.yml` gained an opt-in `bitcoind-regtest` service
(`profiles: ["bitcoin"]` - not part of the default stack, since most
development never touches Bitcoin) and `.github/workflows/ci.yml`'s `test`
job now starts the same node as a plain step (not a `services:` entry -
GitHub Actions service containers cannot be given custom CLI args, and this
image needs `-regtest -txindex=1` to be usable at all), so this suite runs
by default in CI rather than skipping forever.

### No address derivation - out of scope, correctly

Bitcoin deposit addresses come from the same place EVM ones do today: a
merchant registers an address, validated and normalized by
`addresses.service.ts#validateAndNormalize` (already branching on
`family: 'bitcoin'` before this phase, calling `isValidBitcoinAddress`).
Phase 13's scope (per the roadmap) never included HD derivation - that is
Mode A (custodial) work, deferred alongside the rest of custody per ADR
0006, and would need its own `bip32`/output-descriptor design when a
concrete need and the custody decision both exist. Nothing in this ADR
changes that boundary.

### Config and wiring

`apps/blockchain-monitor/src/config.ts` gained `BitcoinNetworkRpcConfig` and
`bitcoinNetworks`, read from `BITCOIN_RPC_URL`/`BITCOIN_RPC_USER`/
`BITCOIN_RPC_PASSWORD` (mainnet) and the `_TESTNET_` equivalents - present in
`.env.example` since before this phase but never read until now.
`validateProductionConfig`'s "no network configured" check now considers
EVM and Bitcoin networks together; Bitcoin does not (yet) require a fallback
RPC URL in production the way a mainnet EVM network does; the expected
topology is one self-hosted `bitcoind`, not a third-party provider with the
single-point-of-failure profile ADR 0011/Phase 11's EVM fallback rule was
written for. `apps/blockchain-monitor/src/main.ts` runs one `ChainScanner`
loop per configured Bitcoin network, identically to the EVM loop, both
against the same generic `MonitorService`.

## Consequences

* `packages/blockchain`: `BitcoinRpcClient`, `BitcoinRpcAdapter`
  (`bitcoin/rpc-client.ts`, `bitcoin/rpc-adapter.ts`), both exported from
  the package root. `normalizeBitcoinAddress` bug fix (above). 8 new
  regtest-backed tests.
* `apps/blockchain-monitor`: `BitcoinNetworkRpcConfig`/`bitcoinNetworks` in
  `config.ts`; `main.ts` wires a `BitcoinRpcAdapter` loop per configured
  Bitcoin network; `ChainScanner`'s address-case bug fix (above, affects the
  EVM path too, though it was never observable there since EVM addresses
  are already lowercase-normalized); one new production-config test; 3 new
  regtest-backed end-to-end tests (PAID flow, reorg, duplicate-transaction).
* `docker-compose.yml`: opt-in `bitcoind-regtest` service.
  `.github/workflows/ci.yml`: the `test` job starts the same node as a
  step, so this suite runs by default in CI instead of skipping forever.
* `README.md#roadmap`'s Phase 13 status moves from "not
  started - address validation only" to done for this phase's scope (see
  the Phase 13 section there for the exact wording and disclosed limits).
* **Not built, deliberately:** a separate EVM-style fast-discovery method
  (unnecessary - `getBlock` itself could be made cheap directly, see above);
  HD address derivation (Mode A, still not live);
  mempool-level detection (only mined blocks are scanned, matching the
  existing EVM behaviour); an indexer-backed `getBalance` (documented as
  expensive, unused by any credit path); mainnet validation (Phase 24/31 -
  this phase's evidence is regtest only, per its own exit criteria).
