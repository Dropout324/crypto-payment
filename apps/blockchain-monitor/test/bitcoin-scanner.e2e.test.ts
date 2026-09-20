import { BitcoinRpcAdapter, BitcoinRpcClient } from '@gateway/blockchain';
import { type PrismaClient, createPrismaClient, decimalToUnits } from '@gateway/database';
import { Network } from '@gateway/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MonitorService } from '../src/monitor.service.js';
import { ChainScanner } from '../src/scanner.js';
import { createMerchant, createPendingInvoice } from './support/fixtures.js';

/**
 * Against a real, local Bitcoin Core regtest node (`docker compose --profile
 * bitcoin up bitcoind-regtest`) - the Phase 13 exit criteria (ADR 0027)
 * explicitly requires the payment flow proven on regtest/testnet, including
 * reorg and duplicate-transaction cases, not just against `FakeBlockchainAdapter`
 * the way `scanner.test.ts`/`monitor.e2e.test.ts` cover the EVM path.
 *
 * Skips cleanly when `BITCOIN_REGTEST_RPC_URL` is unset, the same way
 * `packages/blockchain`'s own regtest suite does - regtest is local and
 * deterministic, but still an optional local service, not something every
 * contributor or CI run is assumed to have up.
 */
const RPC_URL = process.env.BITCOIN_REGTEST_RPC_URL;
const RPC_USER = process.env.BITCOIN_REGTEST_RPC_USER ?? 'gateway';
const RPC_PASSWORD = process.env.BITCOIN_REGTEST_RPC_PASSWORD ?? 'gateway_dev_password';
const NETWORK = Network.BITCOIN_TESTNET;
const WALLET = 'blockchain-monitor-e2e';

describe.skipIf(!RPC_URL)('ChainScanner + MonitorService (Bitcoin regtest)', () => {
  let db: PrismaClient;
  let monitor: MonitorService;
  const nodeRpc = new BitcoinRpcClient(NETWORK, { url: RPC_URL as string, rpcUser: RPC_USER, rpcPassword: RPC_PASSWORD });
  const walletRpc = new BitcoinRpcClient(NETWORK, { url: `${RPC_URL}/wallet/${WALLET}`, rpcUser: RPC_USER, rpcPassword: RPC_PASSWORD });

  beforeAll(async () => {
    db = createPrismaClient();
    await db.$connect();
    monitor = new MonitorService(db, 120);

    await nodeRpc.call('createwallet', [WALLET]).catch(() => undefined); // idempotent across re-runs
    await nodeRpc.call('loadwallet', [WALLET]).catch(() => undefined);
    await mineToNewAddress(101); // matures a spendable coinbase reward
  }, 30_000);

  afterAll(async () => {
    await db?.$disconnect();
  });

  /** `chain_cursors` is keyed by network alone - reset before each test so it does not inherit position from a previous one. */
  async function resetCursor(): Promise<void> {
    await db.chainCursor.deleteMany({ where: { network: NETWORK as never } });
  }

  async function mineToNewAddress(count: number): Promise<void> {
    const address = await walletRpc.call<string>('getnewaddress', ['', 'legacy']);
    await walletRpc.call('generatetoaddress', [count, address]);
  }

  function newAdapter(): BitcoinRpcAdapter {
    return new BitcoinRpcAdapter(NETWORK, { url: RPC_URL as string, rpcUser: RPC_USER, rpcPassword: RPC_PASSWORD });
  }

  it('discovers a real Bitcoin payment and drives it through to PAID with a balanced ledger credit', async () => {
    await resetCursor();
    const merchantId = await createMerchant(db, { feeBps: 100 });
    // Legacy address, not bech32: regtest's bech32 HRP ("bcrt") differs from
    // real testnet's ("tb"), which `isValidBitcoinAddress` correctly never
    // accepts under the 'testnet' kind this adapter validates against - see
    // `packages/blockchain/test/bitcoin/rpc-adapter.test.ts` for the same
    // reasoning.
    const depositAddress = await walletRpc.call<string>('getnewaddress', ['', 'legacy']);
    const { invoiceId } = await createPendingInvoice(db, {
      merchantId,
      network: NETWORK,
      asset: 'BTC',
      decimals: 8,
      cryptoAmountUnits: 5_000_000n, // 0.05 BTC
      requiredConfirmations: 1,
      address: depositAddress,
    });

    const adapter = newAdapter();
    const scanner = new ChainScanner(db, adapter, monitor, NETWORK, 50);
    await scanner.tick(); // establishes the cursor at the current tip; nothing to find yet

    const txid = await walletRpc.call<string>('sendtoaddress', [depositAddress, 0.05]);
    await mineToNewAddress(1);

    const result = await scanner.tick();
    expect(result.candidateTransactions).toBeGreaterThanOrEqual(1);
    expect(result.reorgDetected).toBe(false);

    const invoice = await db.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
    expect(invoice.status).toBe('PAID');
    expect(decimalToUnits(invoice.receivedAmount)).toBe(5_000_000n);

    // `sendtoaddress` typically produces a change output too, in randomised
    // order - the transfer index is whatever the node assigned our output,
    // never assumed to be 0.
    const transfer = await db.tokenTransfer.findFirstOrThrow({ where: { invoiceId } });
    expect(transfer.matchStatus).toBe('CREDITED');

    const ledgerTx = await db.ledgerTransaction.findUniqueOrThrow({
      where: { idempotencyKey: `credit:${NETWORK}:${txid}:${transfer.transferIndex}` },
    });
    const entries = await db.ledgerEntry.findMany({ where: { ledgerTransactionId: ledgerTx.id } });
    expect(entries).toHaveLength(3); // merchant_holdings debit, merchant_payable credit, fee_revenue credit
    const debits = entries.filter((e) => e.direction === 'DEBIT').reduce((sum, e) => sum + decimalToUnits(e.amount), 0n);
    const credits = entries.filter((e) => e.direction === 'CREDIT').reduce((sum, e) => sum + decimalToUnits(e.amount), 0n);
    expect(debits).toBe(credits);
  }, 30_000);

  it('detects a reorg against the last-processed block and rewinds the cursor', async () => {
    await resetCursor();
    const adapter = newAdapter();
    const scanner = new ChainScanner(db, adapter, monitor, NETWORK, 50);
    await scanner.tick();
    await mineToNewAddress(1);
    await scanner.tick();

    const cursorBefore = await db.chainCursor.findUniqueOrThrow({ where: { network: NETWORK } });
    expect(cursorBefore.lastReorgAt).toBeNull();

    const tip = await adapter.getCurrentBlock();
    await nodeRpc.call('invalidateblock', [tip.hash]);
    // Extend a different chain past the invalidated block, so the reorg is
    // not just "undone" but replaced with genuinely new blocks/hashes.
    await mineToNewAddress(2);

    const result = await scanner.tick();
    expect(result.reorgDetected).toBe(true);

    const cursorAfter = await db.chainCursor.findUniqueOrThrow({ where: { network: NETWORK } });
    expect(cursorAfter.lastReorgAt).not.toBeNull();
    expect(cursorAfter.lastProcessedHash).not.toBe(cursorBefore.lastProcessedHash);
  }, 30_000);

  it('does not double-credit when an already-credited payment is rescanned in a later tick', async () => {
    await resetCursor();
    const merchantId = await createMerchant(db, { feeBps: 0 });
    const depositAddress = await walletRpc.call<string>('getnewaddress', ['', 'legacy']);
    const { invoiceId } = await createPendingInvoice(db, {
      merchantId,
      network: NETWORK,
      asset: 'BTC',
      decimals: 8,
      cryptoAmountUnits: 2_000_000n,
      requiredConfirmations: 1,
      address: depositAddress,
    });

    const adapter = newAdapter();
    const scanner = new ChainScanner(db, adapter, monitor, NETWORK, 50);
    await scanner.tick();

    const txid = await walletRpc.call<string>('sendtoaddress', [depositAddress, 0.02]);
    await mineToNewAddress(1);
    await scanner.tick();

    let invoice = await db.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
    expect(invoice.status).toBe('PAID');
    const transfer = await db.tokenTransfer.findFirstOrThrow({ where: { invoiceId } });
    const firstCreditedAt = transfer.creditedAt;
    expect(firstCreditedAt).not.toBeNull();

    // More blocks land on top of the same, already-mined funding transaction
    // (its own confirmations keep climbing) and the scanner keeps ticking -
    // re-observing a transaction that was already credited must change
    // nothing, exactly like an EVM reorg-free rescan.
    await mineToNewAddress(2);
    await scanner.tick();

    invoice = await db.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
    expect(invoice.status).toBe('PAID');
    const transferAfter = await db.tokenTransfer.findFirstOrThrow({ where: { invoiceId } });
    expect(transferAfter.creditedAt?.getTime()).toBe(firstCreditedAt?.getTime());

    const ledgerCount = await db.ledgerTransaction.count({
      where: { idempotencyKey: `credit:${NETWORK}:${txid}:${transfer.transferIndex}` },
    });
    expect(ledgerCount).toBe(1);
  }, 30_000);
});
