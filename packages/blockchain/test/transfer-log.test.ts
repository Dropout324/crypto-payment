import { describe, expect, it } from 'vitest';
import {
  TRANSFER_EVENT_TOPIC,
  type RawEvmLog,
  nativeTransfer,
  parseTransferLog,
  parseTransferLogs,
} from '../src/evm/transfer-log.js';

const USDT_CONTRACT = '0xdAC17F958D2ee523a2206206994597C13D831ec7'.slice(0, 42);
const FROM = '0x1111111111111111111111111111111111111111'.slice(0, 42);
const TO = '0x2222222222222222222222222222222222222222'.slice(0, 42);

function topicFromAddress(address: string): string {
  return `0x${'0'.repeat(24)}${address.slice(2).toLowerCase()}`;
}

function dataFromAmount(amount: bigint): string {
  return `0x${amount.toString(16).padStart(64, '0')}`;
}

function makeTransferLog(overrides: Partial<RawEvmLog> & { amount?: bigint } = {}): RawEvmLog {
  const { amount = 100_000_000n, ...rest } = overrides;
  return {
    address: USDT_CONTRACT,
    topics: [TRANSFER_EVENT_TOPIC, topicFromAddress(FROM), topicFromAddress(TO)],
    data: dataFromAmount(amount),
    logIndex: 0,
    ...rest,
  };
}

describe('parseTransferLog', () => {
  it('parses a well-formed Transfer event', () => {
    const transfer = parseTransferLog(makeTransferLog({ amount: 100_000_000n, logIndex: 5 }));
    expect(transfer).toEqual({
      transferIndex: 5,
      tokenContract: USDT_CONTRACT.toLowerCase(),
      fromAddress: FROM.toLowerCase(),
      toAddress: TO.toLowerCase(),
      amount: 100_000_000n,
    });
  });

  it('handles the full uint256 range without precision loss', () => {
    const max = (1n << 256n) - 1n;
    const transfer = parseTransferLog(makeTransferLog({ amount: max }));
    expect(transfer?.amount).toBe(max);
  });

  it('returns null for a zero-value transfer', () => {
    // Standard-compliant but moves no funds; must not be credited.
    expect(parseTransferLog(makeTransferLog({ amount: 0n }))).toBeNull();
  });

  it('returns null for a log with the wrong topic count (not a Transfer)', () => {
    const log = makeTransferLog();
    expect(parseTransferLog({ ...log, topics: log.topics.slice(0, 2) })).toBeNull();
  });

  it('returns null for a log with a different event signature', () => {
    const log = makeTransferLog();
    const approvalTopic = `0x${'9'.repeat(64)}`;
    expect(parseTransferLog({ ...log, topics: [approvalTopic, log.topics[1] as string, log.topics[2] as string] })).toBeNull();
  });

  it('is case-insensitive on the topic0 match', () => {
    const log = makeTransferLog();
    const upper = TRANSFER_EVENT_TOPIC.toUpperCase().replace('0X', '0x');
    const transfer = parseTransferLog({ ...log, topics: [upper, log.topics[1] as string, log.topics[2] as string] });
    expect(transfer).not.toBeNull();
  });

  it('returns null (not throw) for a malformed address topic', () => {
    const log = makeTransferLog();
    const badTopic = `0x${'ff'.repeat(32)}`; // non-zero padding, not a real address encoding
    expect(parseTransferLog({ ...log, topics: [log.topics[0] as string, badTopic, log.topics[2] as string] })).toBeNull();
  });

  it('returns null (not throw) for malformed data', () => {
    const log = makeTransferLog();
    expect(parseTransferLog({ ...log, data: '0xzz' })).toBeNull();
    expect(parseTransferLog({ ...log, data: '0x' })).toBeNull();
  });

  it('normalizes the emitting contract address to lowercase', () => {
    const log = makeTransferLog({ address: USDT_CONTRACT });
    const transfer = parseTransferLog(log);
    expect(transfer?.tokenContract).toBe(USDT_CONTRACT.toLowerCase());
  });
});

describe('parseTransferLogs', () => {
  it('parses only the Transfer logs out of a mixed receipt', () => {
    const transferLog = makeTransferLog({ logIndex: 0 });
    const unrelatedLog: RawEvmLog = {
      address: USDT_CONTRACT,
      topics: [`0x${'a'.repeat(64)}`],
      data: '0x',
      logIndex: 1,
    };
    const secondTransfer = makeTransferLog({ logIndex: 2, amount: 500n });

    const transfers = parseTransferLogs([transferLog, unrelatedLog, secondTransfer]);
    expect(transfers).toHaveLength(2);
    expect(transfers.map((t) => t.transferIndex)).toEqual([0, 2]);
  });

  it('returns an empty array for a receipt with no transfers', () => {
    expect(parseTransferLogs([])).toEqual([]);
  });
});

describe('nativeTransfer', () => {
  it('uses the -1 sentinel index reserved for native transfers', () => {
    const transfer = nativeTransfer({ fromAddress: FROM, toAddress: TO, value: 10n ** 18n });
    expect(transfer).toEqual({
      transferIndex: -1,
      tokenContract: null,
      fromAddress: FROM.toLowerCase(),
      toAddress: TO.toLowerCase(),
      amount: 10n ** 18n,
    });
  });

  it('returns null for a zero-value native transfer', () => {
    expect(nativeTransfer({ fromAddress: FROM, toAddress: TO, value: 0n })).toBeNull();
  });

  it('allows an unknown sender (contract-internal transfers)', () => {
    const transfer = nativeTransfer({ fromAddress: null, toAddress: TO, value: 1n });
    expect(transfer?.fromAddress).toBeNull();
  });
});
