import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

/**
 * Per-request context carried across `await`s, so a log line written deep
 * inside a service - or by the exception filter - carries the id of the
 * request it belongs to without every call site threading it through.
 */

export const REQUEST_ID_HEADER = 'x-request-id';

export interface RequestContext {
  requestId: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithRequestContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

export function currentRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

/** For `createLogger({ context })`: adds `requestId` to every line written while a request is being handled. */
export function requestContextLogFields(): Record<string, unknown> | undefined {
  const context = storage.getStore();
  return context ? { requestId: context.requestId } : undefined;
}

const ACCEPTABLE_REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * Adopts a caller-supplied `X-Request-Id` so one request can be followed
 * from `apps/web` into `apps/api` (and into a merchant's own logs), but only
 * when it looks like an id. The header is attacker-controlled: an unbounded
 * or free-text value would be echoed into responses and every log line of
 * the request, so anything else is replaced with a fresh UUID.
 */
export function resolveRequestId(header: string | readonly string[] | undefined): string {
  const candidate = typeof header === 'string' ? header : header?.[0];
  return candidate !== undefined && ACCEPTABLE_REQUEST_ID.test(candidate) ? candidate : randomUUID();
}
