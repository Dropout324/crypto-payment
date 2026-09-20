import { describe, expect, it } from 'vitest';
import {
  ReorgVerdict,
  confirmationProgress,
  countConfirmations,
  detectReorg,
  effectiveConfirmations,
  isConfirmed,
  isWithinReorgWindow,
  reorgRewindTarget,
} from '../src/confirmations.js';

describe('countConfirmations', () => {
  it('counts the mining block itself as 1 confirmation', () => {
    expect(countConfirmations({ blockNumber: 100n, chainTip: 100n })).toBe(1);
  });

  it('counts each additional block on top', () => {
    expect(countConfirmations({ blockNumber: 100n, chainTip: 112n })).toBe(13);
  });

  it('returns 0 for a stale tip that has not caught up to the block yet', () => {
    expect(countConfirmations({ blockNumber: 100n, chainTip: 99n })).toBe(0);
  });

  it('rejects a non-positive block number', () => {
    expect(() => countConfirmations({ blockNumber: 0n, chainTip: 10n })).toThrow(/must be positive/);
  });
});

describe('isConfirmed', () => {
  it('is false one confirmation short of the threshold', () => {
    expect(isConfirmed(11, 12)).toBe(false);
  });

  it('is true exactly at the threshold', () => {
    expect(isConfirmed(12, 12)).toBe(true);
  });

  it('is true beyond the threshold', () => {
    expect(isConfirmed(50, 12)).toBe(true);
  });

  it('rejects a non-positive required count', () => {
    expect(() => isConfirmed(5, 0)).toThrow(/positive integer/);
  });
});

describe('effectiveConfirmations', () => {
  it('uses the asset default with no override', () => {
    expect(effectiveConfirmations(12)).toBe(12);
  });

  it('lets a merchant raise the requirement', () => {
    expect(effectiveConfirmations(12, 20)).toBe(20);
  });

  it('never lets a merchant lower the requirement below the asset floor', () => {
    expect(effectiveConfirmations(12, 3)).toBe(12);
  });

  it('rejects a non-positive override', () => {
    expect(() => effectiveConfirmations(12, 0)).toThrow(/positive integer/);
  });
});

describe('confirmationProgress', () => {
  it('reports partial progress', () => {
    expect(confirmationProgress(3, 12)).toEqual({
      current: 3,
      required: 12,
      percent: 25,
      complete: false,
    });
  });

  it('clamps current at the requirement even if confirmations overshoot', () => {
    expect(confirmationProgress(50, 12)).toEqual({
      current: 12,
      required: 12,
      percent: 100,
      complete: true,
    });
  });

  it('reports zero progress before anything confirms', () => {
    expect(confirmationProgress(0, 12).percent).toBe(0);
  });
});

describe('detectReorg', () => {
  it('is INTACT when the hash still matches', () => {
    expect(
      detectReorg({ storedBlockHash: '0xABC', currentBlockHash: '0xabc' }),
    ).toBe(ReorgVerdict.INTACT);
  });

  it('is REORGED when the hash at that height changed', () => {
    expect(
      detectReorg({ storedBlockHash: '0xabc', currentBlockHash: '0xdef' }),
    ).toBe(ReorgVerdict.REORGED);
  });

  it('is MISSING when the height no longer exists', () => {
    expect(detectReorg({ storedBlockHash: '0xabc', currentBlockHash: null })).toBe(
      ReorgVerdict.MISSING,
    );
  });
});

describe('reorg window and rewind', () => {
  it('is within the window near the tip', () => {
    expect(isWithinReorgWindow(95n, 100n, 12)).toBe(true);
  });

  it('is outside the window well behind the tip', () => {
    expect(isWithinReorgWindow(50n, 100n, 12)).toBe(false);
  });

  it('rewinds to reorgDepth blocks behind the tip', () => {
    expect(reorgRewindTarget(100n, 100n, 12)).toBe(88n);
  });

  it('never rewinds past block 1', () => {
    expect(reorgRewindTarget(5n, 5n, 12)).toBe(1n);
  });

  it('never rewinds further forward than where we already were', () => {
    // Chain tip jumped far ahead (a monitor that was offline); do not skip
    // straight to near the new tip, stay at the last processed block.
    expect(reorgRewindTarget(10n, 10_000n, 12)).toBe(10n);
  });
});
