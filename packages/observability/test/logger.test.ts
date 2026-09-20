import { describe, expect, it } from 'vitest';
import { REDACTED } from '@gateway/security';
import { createLogger, requestContextLogFields, runWithRequestContext } from '../src/index.js';

function capture(options: { level?: string; context?: () => Record<string, unknown> | undefined } = {}) {
  const lines: Array<Record<string, unknown>> = [];
  const raw: string[] = [];
  const logger = createLogger({
    service: 'test-service',
    level: options.level ?? 'debug',
    context: options.context,
    destination: {
      write(line: string) {
        raw.push(line);
        lines.push(JSON.parse(line) as Record<string, unknown>);
      },
    },
  });
  return { logger, lines, raw };
}

const API_KEY = `pk_live_abcdefgh.${'a'.repeat(40)}`;
const WEBHOOK_SECRET = `whsec_${'b'.repeat(40)}`;
const JWT = `eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyXzEyMyJ9.${'c'.repeat(32)}`;

describe('createLogger', () => {
  it('writes one JSON object per line with service, level and ISO time', () => {
    const { logger, lines } = capture();
    logger.info({ invoiceId: 'inv_1' }, 'invoice created');

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ service: 'test-service', level: 'info', msg: 'invoice created', invoiceId: 'inv_1' });
    expect(typeof lines[0]!.time).toBe('string');
    expect(Number.isNaN(Date.parse(lines[0]!.time as string))).toBe(false);
  });

  it('redacts sensitive field names in the merge object, at any depth', () => {
    const { logger, lines, raw } = capture();
    logger.info({ password: 'hunter2', endpoint: { webhookSecret: 'plain', url: 'https://merchant.example' } }, 'x');

    expect(lines[0]!.password).toBe(REDACTED);
    expect(lines[0]!.endpoint).toEqual({ webhookSecret: REDACTED, url: 'https://merchant.example' });
    expect(raw.join('')).not.toContain('hunter2');
  });

  it('redacts credential-shaped values in the message and in interpolation arguments', () => {
    const { logger, raw } = capture();
    logger.warn(`rejected key ${API_KEY}`);
    logger.info('session %s for %o', JWT, { note: WEBHOOK_SECRET });

    const output = raw.join('');
    expect(output).not.toContain(API_KEY);
    expect(output).not.toContain(JWT);
    expect(output).not.toContain(WEBHOOK_SECRET);
    expect(output).toContain(REDACTED);
  });

  it('redacts child-logger bindings, which pino never passes through the log formatter', () => {
    const { logger, lines, raw } = capture();
    logger.child({ authorization: `Bearer ${JWT}`, loop: 'webhooks' }).info('tick');

    expect(lines[0]!.authorization).toBe(REDACTED);
    expect(lines[0]!.loop).toBe('webhooks');
    expect(raw.join('')).not.toContain(JWT);
  });

  it('keeps an error stack but redacts secrets inside the message and stack', () => {
    const { logger, lines, raw } = capture();
    const error = Object.assign(new Error(`delivery signed with ${WEBHOOK_SECRET} failed`), { code: 'E_DELIVERY' });
    logger.error({ err: error }, 'delivery failed');

    const err = lines[0]!.err as Record<string, unknown>;
    expect(err.type).toBe('Error');
    expect(err.code).toBe('E_DELIVERY');
    expect(typeof err.stack).toBe('string');
    expect(err.stack).toContain('logger.test.ts');
    expect(raw.join('')).not.toContain(WEBHOOK_SECRET);
  });

  it('accepts pino\'s logger.error(err) form and uses the (redacted) error message as msg', () => {
    const { logger, lines, raw } = capture();
    logger.error(new Error(`bad token ${JWT}`));

    expect(lines[0]!.msg).toBe(`bad token ${REDACTED}`);
    expect((lines[0]!.err as Record<string, unknown>).type).toBe('Error');
    expect(raw.join('')).not.toContain(JWT);
  });

  it('adds the current request id from async context to every line written inside the request', async () => {
    const { logger, lines } = capture({ context: requestContextLogFields });

    await runWithRequestContext({ requestId: 'req-abc-123' }, async () => {
      await new Promise((resolve) => setImmediate(resolve));
      logger.info('inside');
    });
    logger.info('outside');

    expect(lines[0]).toMatchObject({ msg: 'inside', requestId: 'req-abc-123' });
    expect(lines[1]!.requestId).toBeUndefined();
  });

  it('respects the level and rejects an unknown LOG_LEVEL at construction', () => {
    const { logger, lines } = capture({ level: 'warn' });
    logger.info('dropped');
    logger.warn('kept');
    expect(lines.map((line) => line.msg)).toEqual(['kept']);

    expect(() => createLogger({ service: 'x', level: 'verbose' })).toThrow(/LOG_LEVEL/);
  });
});
