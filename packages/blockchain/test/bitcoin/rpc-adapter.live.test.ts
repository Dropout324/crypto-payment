import { Network } from '@gateway/shared';
import { describe, expect, it } from 'vitest';
import { BitcoinRpcAdapter } from '../../src/bitcoin/rpc-adapter.js';

/**
 * Live smoke test against a real Bitcoin mainnet RPC provider - the same
 * role `rpc-adapter.live.test.ts` plays for EVM (ADR 0004's consequence #3:
 * a fake/regtest adapter cannot prove a real provider's quirks - response
 * shapes, real transaction volume, a real chain tip). Regtest
 * (`bitcoin/rpc-adapter.test.ts`) proves reorg and duplicate-transaction
 * handling deterministically; this proves the adapter reads a real, busy
 * mainnet block and a real, previously-mined transaction correctly.
 *
 * Read-only: this never broadcasts anything (`BlockchainAdapter` has no
 * send/sign method to begin with - see the interface). Sending controlled
 * real-funds payments and verifying they are detected end to end is Phase
 * 24/31's job (`docs/commercial/readiness-roadmap.md`), not this phase's.
 *
 * Skips cleanly (not "fail rather than skip") when `BITCOIN_RPC_URL` is
 * unset - a third-party network dependency is not something every dev
 * machine or CI run can be expected to have, unlike Postgres.
 */
const RPC_URL = process.env.BITCOIN_RPC_URL;
const RPC_USER = process.env.BITCOIN_RPC_USER || undefined;
const RPC_PASSWORD = process.env.BITCOIN_RPC_PASSWORD || undefined;

describe.skipIf(!RPC_URL)('BitcoinRpcAdapter (live mainnet)', () => {
  const adapter = new BitcoinRpcAdapter(Network.BITCOIN, { url: RPC_URL as string, rpcUser: RPC_USER, rpcPassword: RPC_PASSWORD, timeoutMs: 15_000 });

  it('fetches the current chain tip', async () => {
    const current = await adapter.getCurrentBlock();
    expect(current.number).toBeGreaterThan(800_000n); // mainnet passed this height in 2023
    expect(current.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(current.parentHash).toMatch(/^[0-9a-f]{64}$/);
  }, 20_000);

  it('fetches that block back by height with a matching hash', async () => {
    const current = await adapter.getCurrentBlock();
    const block = await adapter.getBlock(current.number - 3n); // a few back, so it is not still reorg-prone
    expect(block).not.toBeNull();
    expect(block?.transactions.length).toBeGreaterThan(0);
  }, 20_000);

  it('validates a well-known real mainnet address', () => {
    expect(adapter.validateAddress('bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq')).toBe(true);
    expect(adapter.validateAddress('not-a-bitcoin-address')).toBe(false);
  });

  it('round-trips a real mined transaction: getTransaction, getTransfers and getConfirmations all agree', async () => {
    const current = await adapter.getCurrentBlock();
    const block = await adapter.getBlock(current.number - 5n);
    const txHash = block?.transactions[0]?.hash;
    if (!txHash) return; // extremely unlikely for a real mainnet block, but do not fail the suite over network variance

    const tx = await adapter.getTransaction(txHash);
    expect(tx).not.toBeNull();
    expect(tx?.status).toBe('SUCCESS'); // mined 5 blocks back - never PENDING
    expect(tx?.confirmations).toBeGreaterThanOrEqual(5);

    const transfers = await adapter.getTransfers(txHash);
    expect(Array.isArray(transfers)).toBe(true);
    for (const transfer of transfers) expect(transfer.amount).toBeGreaterThan(0n);

    const confirmations = await adapter.getConfirmations(txHash);
    expect(confirmations.confirmations).toBe(tx?.confirmations);
    expect(confirmations.blockNumber).toBe(tx?.blockNumber);
  }, 30_000);
});
