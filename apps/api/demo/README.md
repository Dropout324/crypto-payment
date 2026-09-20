# Enterprise demo (Phase 19, C9)

One command (`pnpm demo`) that proves the full non-custodial payment
lifecycle end to end against a **real** blockchain testnet - not a
simulation. It creates its own merchant, deposit address and invoice, sends
a real Ethereum Sepolia transaction to that address, waits for
`blockchain-monitor`/`worker` to detect it, track confirmations, credit the
ledger and deliver a signed webhook, then verifies that webhook's signature
itself. Every step goes through the real HTTP API a merchant would use.

Costs **$0**: Sepolia is a public testnet, and its ETH has no real value -
get it free from a faucet (below). No mainnet account, no real funds.

## Setup (once)

1. **Infra**: `pnpm dev:infra` (Postgres + Redis).
2. **A Sepolia RPC URL**: set `ETHEREUM_SEPOLIA_RPC_URL` in `.env` (any
   provider works - Alchemy/Infura/a public endpoint all have free tiers).
3. **Start the three services the demo drives**, each in its own terminal,
   against real `.env` config (not the test app):
   - `pnpm dev:api`
   - `pnpm dev:worker`
   - `pnpm dev:monitor`
4. **Allow the demo's local webhook receiver.** The demo runs its own tiny
   HTTP server on `127.0.0.1` to receive and verify the webhook delivery
   `dev:worker` sends it. The webhook dispatcher's SSRF guard blocks
   loopback/private addresses by default (correct behaviour for real
   merchant-supplied URLs - see `packages/webhooks/src/ssrf-guard.ts`), so
   for this local demo only, set in `.env`:
   ```
   WEBHOOK_BLOCK_PRIVATE_NETWORKS=false
   ```
   and restart `dev:worker`. This is refused outright if `NODE_ENV=production`
   (`apps/worker/src/config.ts`), so it can never end up protecting a real
   deployment by accident - it only ever affects this local demo.

## Run it

```
pnpm demo
```

**First run with no funded wallet** - the script generates a fresh Sepolia
private key, prints it and a faucet link, then exits:

```
No DEMO_WALLET_PRIVATE_KEY configured - generated a fresh one for you.

1. Add this line to your .env:
   DEMO_WALLET_PRIVATE_KEY=0x...

2. Fund this address with FREE Sepolia test ETH (no real money):
   0x...
   Faucets: https://www.alchemy.com/faucets/ethereum-sepolia
            https://sepoliafaucet.com

3. Re-run `pnpm demo` once the faucet transaction confirms.
```

Add the line, get a few faucet drops (a fraction of a second's worth of
"cost" - test ETH is free and worthless by design), wait for the faucet's
own transaction to land, then run `pnpm demo` again.

**A full run** seeds a fresh merchant, registers a deposit address, creates
a $5 invoice, sends the exact required amount of real Sepolia ETH to it,
then prints progress as `blockchain-monitor` detects the transaction and the
ledger tracks it to 3 confirmations (Sepolia's block time is ~12s, so this
takes roughly a minute), followed by the webhook delivery and its signature
verification result, and a final summary:

```
=== Demo complete ===
Invoice:     inv_...  (PAID)
Transaction: https://sepolia.etherscan.io/tx/0x...
Webhook:     invoice.paid, signature valid=true
```

## Two consecutive runs, same observable result

Every run creates its own fresh, uniquely-named merchant, deposit address
and invoice - nothing is shared or mutated between runs, so re-running
`pnpm demo` reproduces the identical shape of success (a full `PAID`
lifecycle with a verified webhook) without any manual database cleanup,
matching this repository's existing seeded-fixture convention (`seedMerchant`,
the E2E suite, `loadtest/seed.ts`).

## What this does and does not prove

- **Proves**: real testnet detection, confirmation tracking, ledger
  crediting, signed webhook delivery and signature verification, driven
  entirely through the public API - the actual mechanism a merchant
  integration depends on.
- **Does not prove**: mainnet behaviour (Phase 24, currently excluded
  - real funds and RPC provider accounts are needed
  for that, unlike this testnet demo), or a publicly reachable/hosted demo
  environment anyone can access without running this repository
  themselves (that piece of Phase 19's scope - "hosted demo reachable by
  invitation" - is deferred until hosting is funded; see the roadmap's
  Phase 19 entry).

## Troubleshooting

- **"API is not reachable"**: `pnpm dev:api` isn't running, or isn't
  listening on the port `DEMO_API_URL`/`API_PORT` expects.
- **Invoice never reaches `PAID`**: confirm `dev:monitor` is running with
  `ETHEREUM_SEPOLIA_RPC_URL` set (its config treats a missing URL as "this
  network's monitor is disabled", not an error - it will simply never
  detect anything).
- **Webhook times out**: confirm `WEBHOOK_BLOCK_PRIVATE_NETWORKS=false` is
  set for the `dev:worker` process specifically (restart it after changing
  `.env` - `tsx watch` does not reload environment variables) and that
  `DEMO_WEBHOOK_PORT` (default `4100`) is free.
- **Wallet balance too low**: get more from a faucet; a single demo run
  spends roughly the invoice's crypto amount (a few thousandths of an ETH)
  plus a small amount of gas.
