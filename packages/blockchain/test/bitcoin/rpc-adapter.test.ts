import { Network } from '@gateway/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import { BitcoinRpcAdapter } from '../../src/bitcoin/rpc-adapter.js';
import { BitcoinRpcClient } from '../../src/bitcoin/rpc-client.js';

/**
 * Against a real, local Bitcoin Core regtest node (`docker compose --profile
 * bitcoin up bitcoind-regtest`), not a fake - regtest is fully local and
 * deterministic (this suite mines its own blocks), so unlike the EVM
 * "`.live.test.ts`" suite against a third-party testnet, there is no
 * network-variance reason to keep this out of the default run once the node
 * is available; it still skips cleanly when it is not (ADR 0027).
 *
 * `BitcoinRpcClient` (not the adapter under test) drives wallet setup here -
 * `sendtoaddress`/`generatetoaddress`/`invalidateblock` are node
 * administration, not part of `BlockchainAdapter`, so the adapter correctly
 * has no methods for them.
 */
const RPC_URL = process.env.BITCOIN_REGTEST_RPC_URL;
const RPC_USER = process.env.BITCOIN_REGTEST_RPC_USER ?? 'gateway';
const RPC_PASSWORD = process.env.BITCOIN_REGTEST_RPC_PASSWORD ?? 'gateway_dev_password';

describe.skipIf(!RPC_URL)('BitcoinRpcAdapter (regtest)', () => {
  const adapter = new BitcoinRpcAdapter(Network.BITCOIN_TESTNET, { url: RPC_URL as string, rpcUser: RPC_USER, rpcPassword: RPC_PASSWORD });
  const rpc = new BitcoinRpcClient(Network.BITCOIN_TESTNET, { url: RPC_URL as string, rpcUser: RPC_USER, rpcPassword: RPC_PASSWORD });

  // Legacy (Base58Check) addresses, not bech32: regtest's bech32 HRP is
  // "bcrt", which differs from real testnet's "tb" - `isValidBitcoinAddress`
  // correctly never accepts "bcrt1..." under the 'testnet' kind, because the
  // real BITCOIN_TESTNET network never produces one. Regtest's legacy
  // version bytes are identical to real testnet's, so legacy addresses are
  // the only ones usable across both without special-casing the validator
  // for a network that is never actually deployed to.
  let depositAddress: string;

  beforeAll(async () => {
    await rpc.call('createwallet', ['rpc-adapter-test']).catch(() => undefined); // idempotent across re-runs
    await rpc.call('loadwallet', ['rpc-adapter-test']).catch(() => undefined);
    depositAddress = await rpcWallet<string>('getnewaddress', ['', 'legacy']);
    const miningAddress = await rpcWallet<string>('getnewaddress', ['', 'legacy']);
    // 101 confirmations matures the coinbase reward so it is spendable.
    await rpcWallet('generatetoaddress', [101, miningAddress]);
  }, 30_000);

  async function rpcWallet<T>(method: string, params: unknown[] = []): Promise<T> {
    const walletRpc = new BitcoinRpcClient(Network.BITCOIN_TESTNET, {
      url: `${RPC_URL}/wallet/rpc-adapter-test`,
      rpcUser: RPC_USER,
      rpcPassword: RPC_PASSWORD,
    });
    return walletRpc.call<T>(method, params);
  }

  it('fetches the current chain tip', async () => {
    const current = await adapter.getCurrentBlock();
    expect(current.number).toBeGreaterThanOrEqual(101n);
    expect(current.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('fetches that block back by height with a matching hash, and by hash with a matching height', async () => {
    const current = await adapter.getCurrentBlock();
    const byHeight = await adapter.getBlock(current.number);
    expect(byHeight?.hash).toBe(current.hash);

    const byHash = await adapter.getBlock(current.hash);
    expect(byHash?.number).toBe(current.number);
  });

  it('validates a real regtest legacy address', () => {
    expect(adapter.validateAddress(depositAddress)).toBe(true);
    expect(adapter.validateAddress('not-a-bitcoin-address')).toBe(false);
  });

  it('returns null/zero for an unknown transaction, never throws', async () => {
    const unknownHash = '00'.repeat(32);
    await expect(adapter.getTransaction(unknownHash)).resolves.toBeNull();
    await expect(adapter.getTransfers(unknownHash)).resolves.toEqual([]);
    await expect(adapter.getConfirmations(unknownHash)).resolves.toMatchObject({ confirmations: 0, blockNumber: null });
  });

  it('round-trips a real mined payment: getTransaction, getTransfers and getConfirmations all agree', async () => {
    const amountBtc = 0.05;
    const txid = await rpcWallet<string>('sendtoaddress', [depositAddress, amountBtc]);
    const miningAddress = await rpcWallet<string>('getnewaddress', ['', 'legacy']);
    await rpcWallet('generatetoaddress', [3, miningAddress]);

    const tx = await adapter.getTransaction(txid);
    expect(tx).not.toBeNull();
    expect(tx?.status).toBe('SUCCESS');
    expect(tx?.blockNumber).not.toBeNull();
    expect(tx?.confirmations).toBeGreaterThanOrEqual(3);

    const transfers = await adapter.getTransfers(txid);
    const ours = transfers.find((t) => t.toAddress === depositAddress);
    expect(ours).toBeDefined();
    expect(ours?.amount).toBe(5_000_000n); // 0.05 BTC in satoshis

    const confirmations = await adapter.getConfirmations(txid);
    expect(confirmations.confirmations).toBe(tx?.confirmations);
    expect(confirmations.blockNumber).toBe(tx?.blockNumber);
  }, 30_000);

  it('does not record a transfer for a transaction still only in the mempool', async () => {
    const txid = await rpcWallet<string>('sendtoaddress', [depositAddress, 0.01]);
    const transfers = await adapter.getTransfers(txid);
    expect(transfers).toEqual([]);

    const confirmations = await adapter.getConfirmations(txid);
    expect(confirmations.confirmations).toBe(0);

    // Clean up: mine it so it does not linger in the shared regtest mempool for later tests.
    const miningAddress = await rpcWallet<string>('getnewaddress', ['', 'legacy']);
    await rpcWallet('generatetoaddress', [1, miningAddress]);
  });

  it('reads a balance via scantxoutset without throwing', async () => {
    const balance = await adapter.getBalance(depositAddress);
    expect(typeof balance).toBe('bigint');
    expect(balance).toBeGreaterThan(0n);
  }, 20_000);

  it('detects a reorg: an orphaned block is no longer reachable by height', async () => {
    const beforeReorg = await adapter.getCurrentBlock();
    await rpc.call('invalidateblock', [beforeReorg.hash]);

    const afterInvalidate = await adapter.getCurrentBlock();
    expect(afterInvalidate.hash).not.toBe(beforeReorg.hash);
    expect(afterInvalidate.number).toBe(beforeReorg.number - 1n);

    // Restore the chain so later tests (and re-runs of this file) see a consistent tip.
    const miningAddress = await rpcWallet<string>('getnewaddress', ['', 'legacy']);
    await rpcWallet('generatetoaddress', [2, miningAddress]);
  }, 20_000);
});
