import type { NetworkValue } from '@gateway/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AnyMonitorEvent } from '../src/adapter.js';
import { FakeBlockchainAdapter, makeTestBlock, makeTestTransaction } from '../src/testing/fake-adapter.js';

const NETWORK = 'ETHEREUM' as NetworkValue;
const ADDR = '0xAbCdEf0000000000000000000000000000000001'.slice(0, 42);

let adapter: FakeBlockchainAdapter;

beforeEach(() => {
  adapter = new FakeBlockchainAdapter(NETWORK);
});

describe('basic reads', () => {
  it('returns null for an unknown transaction rather than throwing', async () => {
    await expect(adapter.getTransaction('0xdeadbeef')).resolves.toBeNull();
  });

  it('returns null for an unknown block', async () => {
    await expect(adapter.getBlock(999n)).resolves.toBeNull();
  });

  it('reports a mined transaction and its block', async () => {
    const tx = makeTestTransaction({ hash: '0xTX1', blockNumber: 100n, blockHash: '0xB100' });
    adapter.addBlock(makeTestBlock({ number: 100n, hash: '0xB100', parentHash: '0xB099', transactions: [tx] }));

    await expect(adapter.getTransaction('0xtx1')).resolves.toMatchObject({ blockNumber: 100n });
    await expect(adapter.getBlock(100n)).resolves.toMatchObject({ hash: '0xB100' });
  });

  it('returns the balance set for an address, defaulting to zero', async () => {
    await expect(adapter.getBalance(ADDR)).resolves.toBe(0n);
    adapter.setBalance(ADDR, 5_000_000n);
    await expect(adapter.getBalance(ADDR)).resolves.toBe(5_000_000n);
  });

  it('reports the tip as the current block', async () => {
    adapter.addBlock(makeTestBlock({ number: 1n, hash: '0xB1', parentHash: '0xB0' }));
    adapter.addBlock(makeTestBlock({ number: 2n, hash: '0xB2', parentHash: '0xB1' }));
    await expect(adapter.getCurrentBlock()).resolves.toMatchObject({ number: 2n, hash: '0xB2' });
  });
});

describe('confirmations', () => {
  it('counts the mining block itself as 1 confirmation', async () => {
    const tx = makeTestTransaction({ hash: '0xTX1', blockNumber: 10n, blockHash: '0xB10' });
    adapter.addBlock(makeTestBlock({ number: 10n, hash: '0xB10', parentHash: '0xB9', transactions: [tx] }));

    await expect(adapter.getConfirmations('0xtx1')).resolves.toMatchObject({ confirmations: 1 });
  });

  it('increases confirmations as new blocks arrive', async () => {
    const tx = makeTestTransaction({ hash: '0xTX1', blockNumber: 10n, blockHash: '0xB10' });
    adapter.addBlock(makeTestBlock({ number: 10n, hash: '0xB10', parentHash: '0xB9', transactions: [tx] }));
    adapter.addBlock(makeTestBlock({ number: 11n, hash: '0xB11', parentHash: '0xB10' }));
    adapter.addBlock(makeTestBlock({ number: 12n, hash: '0xB12', parentHash: '0xB11' }));

    await expect(adapter.getConfirmations('0xtx1')).resolves.toMatchObject({ confirmations: 3 });
  });

  it('reports 0 confirmations for an unmined transaction', async () => {
    adapter.addBlock(makeTestBlock({ number: 1n, hash: '0xB1', parentHash: '0xB0' }));
    await expect(adapter.getConfirmations('0xunknown')).resolves.toMatchObject({
      confirmations: 0,
      blockNumber: null,
    });
  });
});

describe('reorg simulation', () => {
  it('emits a reorg event and drops the orphaned transaction', async () => {
    const events: AnyMonitorEvent[] = [];
    await adapter.monitorTransactions({
      onEvent: (event) => events.push(event),
      onError: () => {
        throw new Error('unexpected monitor error');
      },
    });

    const orphanedTx = makeTestTransaction({ hash: '0xORPHAN', blockNumber: 5n, blockHash: '0xB5-orig' });
    adapter.addBlock(makeTestBlock({ number: 1n, hash: '0xB1', parentHash: '0xB0' }));
    adapter.addBlock(makeTestBlock({ number: 5n, hash: '0xB5-orig', parentHash: '0xB4', transactions: [orphanedTx] }));

    await expect(adapter.getTransaction('0xORPHAN')).resolves.not.toBeNull();

    const replacement = makeTestBlock({ number: 5n, hash: '0xB5-new', parentHash: '0xB4' });
    adapter.reorganize(5n, [replacement]);

    // The orphaned transaction is gone - a monitor re-reading it must see it
    // vanish, never keep counting confirmations on an abandoned branch.
    await expect(adapter.getTransaction('0xORPHAN')).resolves.toBeNull();
    await expect(adapter.getCurrentBlock()).resolves.toMatchObject({ hash: '0xB5-new' });

    const reorgEvents = events.filter((e) => e.type === 'reorg');
    expect(reorgEvents).toHaveLength(1);
    expect(reorgEvents[0]).toMatchObject({ fromBlock: 5n, newTip: 5n });
  });

  it('preserves a transaction that survives the reorg unchanged', async () => {
    const survivor = makeTestTransaction({ hash: '0xSURVIVOR', blockNumber: 3n, blockHash: '0xB3' });
    adapter.addBlock(makeTestBlock({ number: 1n, hash: '0xB1', parentHash: '0xB0' }));
    adapter.addBlock(makeTestBlock({ number: 3n, hash: '0xB3', parentHash: '0xB2', transactions: [survivor] }));
    adapter.addBlock(makeTestBlock({ number: 5n, hash: '0xB5', parentHash: '0xB4' }));

    // Reorg only affects block 5 onward; block 3 is untouched.
    adapter.reorganize(5n, [makeTestBlock({ number: 5n, hash: '0xB5-new', parentHash: '0xB4' })]);

    await expect(adapter.getTransaction('0xSURVIVOR')).resolves.toMatchObject({ blockNumber: 3n });
  });

  it('lets a transaction re-mine at a different block after being orphaned', async () => {
    const original = makeTestTransaction({ hash: '0xTX', blockNumber: 5n, blockHash: '0xB5-orig' });
    adapter.addBlock(makeTestBlock({ number: 1n, hash: '0xB1', parentHash: '0xB0' }));
    adapter.addBlock(makeTestBlock({ number: 5n, hash: '0xB5-orig', parentHash: '0xB4', transactions: [original] }));

    const remined = makeTestTransaction({ hash: '0xTX', blockNumber: 6n, blockHash: '0xB6-new' });
    adapter.reorganize(5n, [
      makeTestBlock({ number: 5n, hash: '0xB5-new', parentHash: '0xB4' }),
      makeTestBlock({ number: 6n, hash: '0xB6-new', parentHash: '0xB5-new', transactions: [remined] }),
    ]);

    await expect(adapter.getTransaction('0xTX')).resolves.toMatchObject({ blockNumber: 6n });
  });

  it('stops delivering events after the handle is stopped', async () => {
    const events: AnyMonitorEvent[] = [];
    const handle = await adapter.monitorTransactions({
      onEvent: (event) => events.push(event),
      onError: () => {},
    });

    adapter.addBlock(makeTestBlock({ number: 1n, hash: '0xB1', parentHash: '0xB0' }));
    expect(events).toHaveLength(1);

    await handle.stop();
    adapter.addBlock(makeTestBlock({ number: 2n, hash: '0xB2', parentHash: '0xB1' }));
    expect(events).toHaveLength(1);
  });
});

describe('transfers', () => {
  it('returns the transfers configured for a transaction hash', async () => {
    adapter.setTransfers('0xTX', [
      { transferIndex: 0, tokenContract: null, fromAddress: ADDR, toAddress: ADDR, amount: 100n },
    ]);
    await expect(adapter.getTransfers('0xtx')).resolves.toHaveLength(1);
  });

  it('returns an empty array for a transaction with no transfers configured', async () => {
    await expect(adapter.getTransfers('0xunknown')).resolves.toEqual([]);
  });
});
