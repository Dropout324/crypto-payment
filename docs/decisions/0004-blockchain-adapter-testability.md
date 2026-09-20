# ADR 0004 - The BlockchainAdapter interface is built and proven without an RPC provider

Status: Accepted
Date: 2026-09-08

## Context

Phases 3-4 (blockchain adapters, monitor, matching, confirmation engine, reorg
handling) are the highest-risk code in the system, and no RPC provider
credentials were available while building them.

## Decision

The `BlockchainAdapter` interface (SPEC section 4) and everything that
consumes it are designed so the hard logic - transfer parsing, confirmation
counting, reorg detection, the invoice state machine - depends only on the
interface, never on a concrete provider. Three things make this fully
testable before any real RPC exists:

1. **`FakeBlockchainAdapter`** (`packages/blockchain/src/testing/fake-adapter.ts`)
   is a real, minimal implementation of the interface, not a mock. It supports
   `reorganize()`, which truncates and replaces chain history exactly as a
   real reorg would, and emits the same `reorg` event a real adapter must.
2. **Log/output parsing is pure.** `parseTransferLog` takes a plain
   `{address, topics, data, logIndex}` object - the same shape every EVM
   JSON-RPC provider returns - and is tested against hand-built ERC-20
   Transfer logs plus the standard's fixed event topic, with no network call.
3. **Address validation is self-verifying where memory is fallible.** EIP-55
   checksum tests use the official EIP-55 test vectors. Bitcoin address tests
   build Base58Check and Bech32/Bech32m addresses with an independent
   test-only encoder and check the implementation accepts what the encoder
   produces and rejects deliberately corrupted variants - rather than
   depending entirely on long address strings recalled from memory. A few
   extremely well-attested real addresses (the Bitcoin genesis address, the
   BIP-173 P2WPKH test vector) are included as an additional sanity check.

## Consequences

* When an RPC provider is added, the concrete adapter (e.g. an
  `EthereumJsonRpcAdapter`) only has to satisfy the interface; the monitor,
  matcher and confirmation engine it plugs into are already tested.
* `FakeBlockchainAdapter` ships in `packages/blockchain` (not a separate
  `-testing` package) because Phase 9's integration and E2E suites need it too.
* This does not remove the need for real-network testing before production:
  a fake adapter cannot prove a real provider's quirks (rate limits,
  inconsistent `logIndex` semantics, mempool visibility). That verification is
  still required once RPC access exists, and is tracked as a gate before
  Phase 10 deployment.
