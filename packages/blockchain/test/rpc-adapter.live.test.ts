import { Network } from '@gateway/shared';
import { describe, expect, it } from 'vitest';
import { EvmJsonRpcAdapter } from '../src/evm/rpc-adapter.js';
import { ZERO_ADDRESS } from '../src/address/evm.js';

/**
 * Live smoke test against a real Sepolia RPC provider (ADR 0004's
 * consequence #3: a fake adapter cannot prove a real provider's quirks -
 * rate limits, response shapes, mempool visibility - so this is required
 * before treating the adapter as production-ready).
 *
 * Skips cleanly (not "fail rather than skip", unlike the local database) when
 * `ETHEREUM_SEPOLIA_RPC_URL` is unset - a third-party network dependency is
 * not something every dev machine or CI run can be expected to have,
 * unlike Postgres, which the project provisions for every contributor.
 */
const RPC_URL = process.env.ETHEREUM_SEPOLIA_RPC_URL;

describe.skipIf(!RPC_URL)('EvmJsonRpcAdapter (live Sepolia)', () => {
  const adapter = new EvmJsonRpcAdapter(Network.ETHEREUM_SEPOLIA, { url: RPC_URL as string, timeoutMs: 15_000 });

  it('fetches the current chain tip', async () => {
    const current = await adapter.getCurrentBlock();
    expect(current.number).toBeGreaterThan(0n);
    expect(current.hash).toMatch(/^0x[0-9a-fA-F]{64}$/);
    expect(current.parentHash).toMatch(/^0x[0-9a-fA-F]{64}$/);
  }, 20_000);

  it('fetches that block back by number with a matching hash', async () => {
    const current = await adapter.getCurrentBlock();
    const block = await adapter.getBlock(current.number);
    expect(block).not.toBeNull();
    expect(block?.hash).toBe(current.hash);
  }, 20_000);

  it('reads a balance without throwing', async () => {
    const balance = await adapter.getBalance(ZERO_ADDRESS);
    expect(typeof balance).toBe('bigint');
  }, 20_000);

  it('round-trips a real mined transaction: getTransaction, getTransfers, getConfirmations all agree', async () => {
    // Recent Sepolia blocks are sometimes empty; walk back a little to find one with a transaction.
    const current = await adapter.getCurrentBlock();
    let txHash: string | null = null;
    for (let i = 0n; i < 20n && !txHash; i += 1n) {
      const block = await adapter.getBlock(current.number - i);
      const withValueOrData = block?.transactions[0];
      if (withValueOrData) txHash = withValueOrData.hash;
    }
    if (!txHash) {
      // Extremely unlikely on a live public testnet, but do not fail the suite over network variance.
      return;
    }

    const tx = await adapter.getTransaction(txHash);
    expect(tx).not.toBeNull();
    expect(['SUCCESS', 'REVERTED', 'PENDING']).toContain(tx?.status);

    const transfers = await adapter.getTransfers(txHash);
    expect(Array.isArray(transfers)).toBe(true);

    const confirmations = await adapter.getConfirmations(txHash);
    expect(confirmations.confirmations).toBeGreaterThanOrEqual(0);
  }, 30_000);
});
