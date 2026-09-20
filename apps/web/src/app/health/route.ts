/**
 * Liveness only - mirrors `apps/api`'s `GET /v1/health` (see
 * `apps/api/src/health/health.controller.ts`'s doc comment for the
 * liveness/readiness split this repo follows everywhere). This process's
 * only dependency is the API it calls per-request on behalf of a browser;
 * that call already carries its own timeout and error handling in
 * `apiRequest()`, so there is nothing meaningful to check here beyond "the
 * Next.js server is up and handling requests" - the same reasoning that
 * keeps `apps/api`'s `/health` dependency-free. `apps/web` has no `/ready`
 * for the same reason: it holds no connection pool and has no dependency
 * whose absence should stop an orchestrator from routing to it.
 */
export function GET(): Response {
  return Response.json({ status: 'ok', timestamp: new Date().toISOString() });
}
