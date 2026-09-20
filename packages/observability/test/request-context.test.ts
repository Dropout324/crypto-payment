import { describe, expect, it } from 'vitest';
import { currentRequestContext, resolveRequestId, runWithRequestContext } from '../src/index.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('resolveRequestId', () => {
  it('adopts a well-formed caller-supplied id', () => {
    expect(resolveRequestId('web-2f1c9e:42')).toBe('web-2f1c9e:42');
    expect(resolveRequestId(['first-id', 'second-id'])).toBe('first-id');
  });

  it('replaces a missing, oversized or free-text id with a fresh UUID', () => {
    expect(resolveRequestId(undefined)).toMatch(UUID);
    expect(resolveRequestId('')).toMatch(UUID);
    expect(resolveRequestId('a'.repeat(129))).toMatch(UUID);
    expect(resolveRequestId('id\n{"level":"fatal"}')).toMatch(UUID);
    expect(resolveRequestId('<script>')).toMatch(UUID);
  });

  it('generates a distinct id per call', () => {
    expect(resolveRequestId(undefined)).not.toBe(resolveRequestId(undefined));
  });
});

describe('request context', () => {
  it('is visible across awaits inside the run and absent outside it', async () => {
    const seen = await runWithRequestContext({ requestId: 'r1' }, async () => {
      await Promise.resolve();
      return currentRequestContext()?.requestId;
    });
    expect(seen).toBe('r1');
    expect(currentRequestContext()).toBeUndefined();
  });
});
