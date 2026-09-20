import { Network } from '@gateway/shared';
import { describe, expect, it } from 'vitest';
import { EvmJsonRpcAdapter, toHexQuantity } from '../src/evm/rpc-adapter.js';
import { TRANSFER_EVENT_TOPIC } from '../src/evm/transfer-log.js';

type RpcHandler = (method: string, params: unknown[]) => unknown;

function makeFetch(handler: RpcHandler): typeof fetch {
  return (async (_url: string | URL, init?: RequestInit) => {
    const payload = JSON.parse(String(init?.body ?? '{}'));
    const build = (req: { id: number; method: string; params: unknown[] }): unknown => {
      try {
        return { jsonrpc: '2.0', id: req.id, result: handler(req.method, req.params) };
      } catch (error) {
        return { jsonrpc: '2.0', id: req.id, error: { code: -32000, message: (error as Error).message } };
      }
    };
    const body = Array.isArray(payload) ? payload.map(build) : build(payload);
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

const TX_HASH = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const FROM = '0x1111111111111111111111111111111111111111';
const TO = '0x2222222222222222222222222222222222222222';
const TOKEN_CONTRACT = '0x3333333333333333333333333333333333333333';

function addressTopic(address: string): string {
  return `0x${'0'.repeat(24)}${address.slice(2).toLowerCase()}`;
}

function amountData(amount: bigint): string {
  return `0x${amount.toString(16).padStart(64, '0')}`;
}

function adapterWith(handler: RpcHandler): EvmJsonRpcAdapter {
  return new EvmJsonRpcAdapter(Network.ETHEREUM_SEPOLIA, { url: 'https://example.invalid/rpc', fetchImpl: makeFetch(handler) });
}

describe('EvmJsonRpcAdapter', () => {
  it('getBalance parses the hex quantity into a bigint', async () => {
    const adapter = adapterWith((method) => {
      expect(method).toBe('eth_getBalance');
      return '0xde0b6b3a7640000'; // 1 ETH
    });
    await expect(adapter.getBalance(FROM)).resolves.toBe(1_000_000_000_000_000_000n);
  });

  it('getTransaction returns null for an unknown hash without throwing', async () => {
    const adapter = adapterWith((method) => (method === 'eth_getTransactionByHash' ? null : method === 'eth_blockNumber' ? '0x64' : null));
    await expect(adapter.getTransaction(TX_HASH)).resolves.toBeNull();
  });

  it('getTransaction reports PENDING with zero confirmations while unmined', async () => {
    const adapter = adapterWith((method) => {
      if (method === 'eth_getTransactionByHash') return { hash: TX_HASH, blockNumber: null, blockHash: null, transactionIndex: null, from: FROM, to: TO, value: '0x0' };
      if (method === 'eth_getTransactionReceipt') return null;
      if (method === 'eth_blockNumber') return '0x64';
      throw new Error(`unexpected method ${method}`);
    });
    const tx = await adapter.getTransaction(TX_HASH);
    expect(tx).toMatchObject({ status: 'PENDING', blockNumber: null, confirmations: 0 });
  });

  it('getTransaction computes confirmations and the gas fee for a mined, successful transaction', async () => {
    const adapter = adapterWith((method) => {
      if (method === 'eth_getTransactionByHash') {
        return { hash: TX_HASH, blockNumber: '0x64', blockHash: '0xblock', transactionIndex: '0x2', from: FROM, to: TO, value: '0x1' };
      }
      if (method === 'eth_getTransactionReceipt') {
        return { status: '0x1', gasUsed: '0x5208', effectiveGasPrice: '0x3b9aca00', logs: [] };
      }
      if (method === 'eth_blockNumber') return '0x6e'; // 110
      throw new Error(`unexpected method ${method}`);
    });
    const tx = await adapter.getTransaction(TX_HASH);
    expect(tx).toMatchObject({ status: 'SUCCESS', blockNumber: 100n, transactionIndex: 2, confirmations: 11 });
    expect(tx?.feeAmount).toBe(21_000n * 1_000_000_000n);
  });

  it('getTransaction reports REVERTED from the receipt status', async () => {
    const adapter = adapterWith((method) => {
      if (method === 'eth_getTransactionByHash') return { hash: TX_HASH, blockNumber: '0x64', blockHash: '0xb', transactionIndex: '0x0', from: FROM, to: TO, value: '0x0' };
      if (method === 'eth_getTransactionReceipt') return { status: '0x0', gasUsed: '0x1', logs: [] };
      if (method === 'eth_blockNumber') return '0x64';
      throw new Error(`unexpected method ${method}`);
    });
    const tx = await adapter.getTransaction(TX_HASH);
    expect(tx?.status).toBe('REVERTED');
  });

  it('getTransfers returns [] for a not-yet-mined transaction', async () => {
    const adapter = adapterWith((method) => {
      if (method === 'eth_getTransactionByHash') return { hash: TX_HASH, blockNumber: null, blockHash: null, transactionIndex: null, from: FROM, to: TO, value: '0x1' };
      if (method === 'eth_getTransactionReceipt') return null;
      throw new Error(`unexpected method ${method}`);
    });
    await expect(adapter.getTransfers(TX_HASH)).resolves.toEqual([]);
  });

  it('getTransfers returns [] for a reverted transaction even though tx.value is nonzero', async () => {
    const adapter = adapterWith((method) => {
      if (method === 'eth_getTransactionByHash') return { hash: TX_HASH, blockNumber: '0x1', blockHash: '0xb', transactionIndex: '0x0', from: FROM, to: TO, value: '0xde0b6b3a7640000' };
      if (method === 'eth_getTransactionReceipt') return { status: '0x0', gasUsed: '0x1', logs: [] };
      throw new Error(`unexpected method ${method}`);
    });
    await expect(adapter.getTransfers(TX_HASH)).resolves.toEqual([]);
  });

  it('getTransfers extracts both the native value transfer and an ERC-20 Transfer log', async () => {
    const amount = 5_000_000n;
    const adapter = adapterWith((method) => {
      if (method === 'eth_getTransactionByHash') {
        return { hash: TX_HASH, blockNumber: '0x1', blockHash: '0xb', transactionIndex: '0x0', from: FROM, to: TO, value: '0xde0b6b3a7640000' };
      }
      if (method === 'eth_getTransactionReceipt') {
        return {
          status: '0x1',
          gasUsed: '0x1',
          logs: [{ address: TOKEN_CONTRACT, topics: [TRANSFER_EVENT_TOPIC, addressTopic(FROM), addressTopic(TO)], data: amountData(amount), logIndex: '0x3' }],
        };
      }
      throw new Error(`unexpected method ${method}`);
    });
    const transfers = await adapter.getTransfers(TX_HASH);
    expect(transfers).toHaveLength(2);
    expect(transfers.find((t) => t.tokenContract === null)).toMatchObject({ transferIndex: -1, amount: 1_000_000_000_000_000_000n });
    expect(transfers.find((t) => t.tokenContract !== null)).toMatchObject({ transferIndex: 3, tokenContract: TOKEN_CONTRACT.toLowerCase(), amount });
  });

  it('getConfirmations returns zero for a transaction with no block yet', async () => {
    const adapter = adapterWith((method) => {
      if (method === 'eth_getTransactionByHash') return null;
      if (method === 'eth_blockNumber') return '0x64';
      throw new Error(`unexpected method ${method}`);
    });
    await expect(adapter.getConfirmations(TX_HASH)).resolves.toEqual({ confirmations: 0, blockNumber: null, chainTip: 100n });
  });

  it('getCurrentBlock combines eth_blockNumber and the block header', async () => {
    const adapter = adapterWith((method, params) => {
      if (method === 'eth_blockNumber') return '0x64';
      if (method === 'eth_getBlockByNumber') {
        expect(params).toEqual(['0x64', false]);
        return { number: '0x64', hash: '0xtip', parentHash: '0xparent', timestamp: '0x60000000', transactions: [] };
      }
      throw new Error(`unexpected method ${method}`);
    });
    await expect(adapter.getCurrentBlock()).resolves.toMatchObject({ number: 100n, hash: '0xtip', parentHash: '0xparent' });
  });

  it('getBlock(number) fetches the block plus a batched receipt lookup for every transaction in it', async () => {
    const adapter = adapterWith((method, params) => {
      if (method === 'eth_getBlockByNumber') {
        expect(params).toEqual([toHexQuantity(50n), true]);
        return {
          number: '0x32',
          hash: '0xblockhash',
          parentHash: '0xparent',
          timestamp: '0x60000000',
          transactions: [{ hash: TX_HASH, blockNumber: '0x32', blockHash: '0xblockhash', transactionIndex: '0x0', from: FROM, to: TO, value: '0x1' }],
        };
      }
      if (method === 'eth_getTransactionReceipt') return { status: '0x1', gasUsed: '0x1', logs: [] };
      throw new Error(`unexpected method ${method}`);
    });
    const block = await adapter.getBlock(50n);
    expect(block).toMatchObject({ number: 50n, hash: '0xblockhash' });
    expect(block?.transactions).toHaveLength(1);
    expect(block?.transactions[0]).toMatchObject({ status: 'SUCCESS' });
  });

  it('getBlock returns null for an unknown block', async () => {
    const adapter = adapterWith(() => null);
    await expect(adapter.getBlock(999_999n)).resolves.toBeNull();
  });

  it('validateAddress checks structural validity only', () => {
    const adapter = adapterWith(() => null);
    expect(adapter.validateAddress(TO)).toBe(true);
    expect(adapter.validateAddress('not-an-address')).toBe(false);
  });

  it('falls back to a second URL only on a transport failure, never on a JSON-RPC application error', async () => {
    let primaryCalls = 0;
    const failingFetch = (async () => {
      primaryCalls += 1;
      throw new Error('ECONNRESET');
    }) as typeof fetch;
    const fallbackFetch = makeFetch(() => '0x1');

    const adapter = new EvmJsonRpcAdapter(Network.ETHEREUM_SEPOLIA, {
      url: 'https://primary.invalid',
      fallbackUrl: 'https://fallback.invalid',
      fetchImpl: (async (url: string | URL, init?: RequestInit) => {
        if (String(url).includes('primary')) return failingFetch(url, init);
        return fallbackFetch(url, init);
      }) as typeof fetch,
    });

    await expect(adapter.getBalance(FROM)).resolves.toBe(1n);
    expect(primaryCalls).toBe(1);
  });

  it('getLightBlock reads tx hash/to/value without ever calling eth_getTransactionReceipt', async () => {
    const receiptCalls: string[] = [];
    const adapter = adapterWith((method, params) => {
      if (method === 'eth_getBlockByNumber') {
        expect(params).toEqual([toHexQuantity(10n), true]);
        return {
          number: '0xa',
          hash: '0xblockhash',
          parentHash: '0xparent',
          timestamp: '0x1',
          transactions: [{ hash: TX_HASH, blockNumber: '0xa', blockHash: '0xblockhash', transactionIndex: '0x0', from: FROM, to: TO, value: '0x5' }],
        };
      }
      if (method === 'eth_getTransactionReceipt') {
        receiptCalls.push(String(params[0]));
        return { status: '0x1', gasUsed: '0x1', logs: [] };
      }
      throw new Error(`unexpected method ${method}`);
    });

    const block = await adapter.getLightBlock(10n);
    expect(block).toMatchObject({ number: 10n, hash: '0xblockhash', parentHash: '0xparent' });
    expect(block?.transactions).toEqual([{ hash: TX_HASH, to: TO, value: 5n }]);
    expect(receiptCalls).toHaveLength(0); // the whole point: no per-transaction receipt fetch
  });

  it('getTransferLogsTo filters eth_getLogs server-side by contract and recipient, and de-duplicates by tx hash', async () => {
    const adapter = adapterWith((method, params) => {
      if (method !== 'eth_getLogs') throw new Error(`unexpected method ${method}`);
      const filter = params[0] as { fromBlock: string; toBlock: string; address: string[]; topics: unknown[] };
      expect(filter).toMatchObject({ fromBlock: toHexQuantity(100n), toBlock: toHexQuantity(105n), address: [TOKEN_CONTRACT] });
      expect(filter.topics).toEqual([TRANSFER_EVENT_TOPIC, null, [addressTopic(TO)]]);
      return [
        { transactionHash: TX_HASH },
        { transactionHash: TX_HASH }, // same tx, two logs - must collapse to one hash
      ];
    });

    const hashes = await adapter.getTransferLogsTo(100n, 105n, [TOKEN_CONTRACT], [TO]);
    expect(hashes).toEqual([TX_HASH]);
  });

  it('getTransferLogsTo skips the RPC call entirely when there is nothing to filter for', async () => {
    const fetchImpl = () => {
      throw new Error('should not be called');
    };
    const adapter = new EvmJsonRpcAdapter(Network.ETHEREUM_SEPOLIA, { url: 'https://example.invalid', fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(adapter.getTransferLogsTo(1n, 2n, [], [TO])).resolves.toEqual([]);
    await expect(adapter.getTransferLogsTo(1n, 2n, [TOKEN_CONTRACT], [])).resolves.toEqual([]);
  });
});
