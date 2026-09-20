import { hostname } from 'node:os';
import pino, { type DestinationStream, type LogFn, type Logger, type LoggerOptions } from 'pino';
import { redact } from '@gateway/security';

export type { Logger } from 'pino';

/**
 * The one logging path for every service (ADR 0019).
 *
 * Principle #8 - "secrets are never logged" - is defined by
 * `@gateway/security`'s `redact()`. This module adds no redaction rules of
 * its own; its job is to make it impossible to emit a line that skips them.
 * pino has three ways data reaches a line, and each is routed through
 * `redact()`:
 *
 * - the merge object (`logger.info({ ... }, msg)`) plus anything `mixin()`
 *   adds                                              -> `formatters.log`
 * - child-logger bindings (`logger.child({ ... })`) and `base`
 *                                                     -> `formatters.bindings`
 * - the message string and printf-style arguments     -> `hooks.logMethod`
 *
 * Errors are flattened to plain objects before `formatters.log` sees them:
 * `redact()` reduces an `Error` to name + message, which would throw away the
 * stack. Flattened, the stack survives as a string and still goes through
 * `redact()`'s value-shape rules like every other string. pino also ships a
 * default serializer for a merge-object key literally named `err` that
 * re-derives its own `type` from `err.constructor.name` - which, applied to
 * an already-flattened plain object, turns our `type: 'Error'` into
 * `type: 'Object'`. `serializers: { err: (v) => v }` below disables it so our
 * flattened shape survives untouched.
 *
 * `formatters.bindings` is only invoked for the base logger pino's own
 * constructor builds - `.child(bindings)` does NOT run its new bindings
 * through it, so a plain `logger.child({...})` would otherwise bypass
 * redaction entirely. `createLogger` returns the pino instance wrapped so
 * every `.child(...)` call - including on the child it returns, recursively -
 * redacts its bindings before pino ever sees them.
 */

export interface CreateLoggerOptions {
  /** Emitted as `service` on every line - the field log queries filter by. */
  service: string;
  /** Defaults to `LOG_LEVEL`, else `info`. */
  level?: string;
  /** Fields evaluated for every line, e.g. the current request id. */
  context?: () => Record<string, unknown> | undefined;
  /** Test seam; defaults to stdout. */
  destination?: DestinationStream;
}

const LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

export function createLogger(options: CreateLoggerOptions): Logger {
  const level = options.level ?? process.env.LOG_LEVEL ?? 'info';
  if (!(LEVELS as readonly string[]).includes(level)) {
    throw new Error(`LOG_LEVEL must be one of ${LEVELS.join(', ')}, got "${level}"`);
  }

  const context = options.context;
  const pinoOptions: LoggerOptions = {
    level,
    base: { service: options.service, pid: process.pid, hostname: hostname() },
    timestamp: pino.stdTimeFunctions.isoTime,
    // Identity, not pino's built-in error serializer - see the module doc
    // comment above for why.
    serializers: { err: (value: unknown) => value },
    formatters: {
      level: (label) => ({ level: label }),
      bindings: (bindings) => redactObject(bindings),
      log: (object) => redactObject(object),
    },
    hooks: {
      logMethod(args, method) {
        method.apply(this, prepareArguments(args) as Parameters<LogFn>);
      },
    },
    ...(context ? { mixin: () => context() ?? {} } : {}),
  };

  const logger = options.destination ? pino(pinoOptions, options.destination) : pino(pinoOptions);
  return wrapChildRedaction(logger);
}

/**
 * Wraps `.child(bindings)` (and every child it subsequently produces) so
 * `bindings` is redacted before pino sees it - see the module doc comment.
 * Every other property/method passes through untouched via `Reflect`.
 */
function wrapChildRedaction(logger: Logger): Logger {
  return new Proxy(logger, {
    get(target, prop, receiver) {
      if (prop === 'child') {
        return (bindings: Record<string, unknown>, options?: unknown) =>
          wrapChildRedaction(
            (target.child as unknown as (b: object, o?: object) => Logger)(redactObject(bindings), options as object),
          );
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

export interface SerializedError {
  type: string;
  message: string;
  stack?: string;
  code?: string | number;
  cause?: SerializedError;
}

/** Plain-object form of an `Error` that keeps its stack and cause chain (bounded). */
export function serializeError(error: Error, depth = 0): SerializedError {
  const code = (error as { code?: unknown }).code;
  return {
    type: error.name,
    message: error.message,
    ...(error.stack ? { stack: error.stack } : {}),
    ...(typeof code === 'string' || typeof code === 'number' ? { code } : {}),
    ...(error.cause instanceof Error && depth < 3 ? { cause: serializeError(error.cause, depth + 1) } : {}),
  };
}

function prepareArguments(args: unknown[]): unknown[] {
  const [first, ...rest] = args;
  let prepared: unknown[];

  if (first instanceof Error) {
    // `logger.error(err)` / `logger.error(err, msg)`: pino would take the
    // message from the error when none is given, so keep that behaviour.
    prepared = [{ err: serializeError(first) }, ...(rest.length > 0 ? rest : [first.message])];
  } else if (typeof first === 'object' && first !== null) {
    prepared = [flattenTopLevelErrors(first as Record<string, unknown>), ...rest];
  } else {
    prepared = args;
  }

  // Index 0, when it is the merge object, is redacted by `formatters.log`
  // (after `mixin` has been merged in). Everything else - the message and any
  // interpolation values - is redacted here, because pino never passes those
  // through a formatter.
  return prepared.map((value, index) =>
    index === 0 && typeof value === 'object' && value !== null ? value : redact(value),
  );
}

function flattenTopLevelErrors(object: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(object)) {
    output[key] = value instanceof Error ? serializeError(value) : value;
  }
  return output;
}

function redactObject(object: Record<string, unknown>): Record<string, unknown> {
  const output = redact(object);
  return typeof output === 'object' && output !== null && !Array.isArray(output)
    ? (output as Record<string, unknown>)
    : { value: output };
}
