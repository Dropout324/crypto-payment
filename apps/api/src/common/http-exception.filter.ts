import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import { RateLimitError, isAppError } from '@gateway/shared';
import { redact } from '@gateway/security';
import { randomUUID } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * Central error boundary.
 *
 * `AppError` subclasses map to their declared HTTP status and a stable
 * machine-readable `code` (SPEC section 15's error contract). Everything else
 * - a bug, an unhandled provider failure - becomes a generic 500 with no
 * internal detail leaked, because the alternative is a stack trace in a
 * merchant-facing response.
 *
 * Every response carries a `request_id` so a merchant's support ticket can be
 * matched to server logs without exposing anything sensitive in between.
 */
@Catch()
export class AppExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('http');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<FastifyReply>();
    const request = ctx.getRequest<FastifyRequest>();
    // `request.requestId` is set by bootstrap.ts's `onRequest` hook in production;
    // the e2e test harness does not register that hook, so this falls back to
    // the raw header (if any) and then a fresh id, same as before.
    const requestId =
      (request as FastifyRequest & { requestId?: string }).requestId ??
      (request.headers['x-request-id'] as string | undefined) ??
      randomUUID();

    if (isAppError(exception)) {
      if (!exception.operational) {
        this.logger.error(redact({ message: exception.message, code: exception.code, requestId }));
      }
      if (exception instanceof RateLimitError) {
        response.header('Retry-After', String(exception.retryAfterSeconds));
      }
      response.status(exception.httpStatus).send(exception.toPublicJSON(requestId));
      return;
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      response.status(status).send({
        error: {
          code: status === 400 ? 'validation_failed' : 'http_error',
          message: typeof body === 'string' ? body : (body as { message?: string }).message ?? exception.message,
          request_id: requestId,
        },
      });
      return;
    }

    // Fastify-level protocol errors - e.g. `FST_ERR_CTP_BODY_TOO_LARGE` for a
    // request over the configured body limit, or a malformed content-type -
    // happen during body parsing, before Nest's pipeline (and therefore
    // `HttpException`) ever gets involved. They are plain `FastifyError`
    // objects with their own `statusCode`, so without this branch a client
    // sending an oversized body was told "Internal server error" (500)
    // instead of 413, and every such request was logged as if it were an
    // application bug rather than the expected rejection it is.
    const fastifyStatusCode =
      exception instanceof Error ? (exception as Error & { statusCode?: unknown }).statusCode : undefined;
    if (typeof fastifyStatusCode === 'number' && fastifyStatusCode >= 400 && fastifyStatusCode < 500) {
      response.status(fastifyStatusCode).send({
        error: { code: 'http_error', message: (exception as Error).message, request_id: requestId },
      });
      return;
    }

    // Anything else is a bug. Log it fully server-side; tell the client nothing.
    this.logger.error(
      redact({
        message: exception instanceof Error ? exception.message : String(exception),
        stack: exception instanceof Error ? exception.stack : undefined,
        requestId,
      }),
    );
    response.status(500).send({
      error: { code: 'internal_error', message: 'Internal server error', request_id: requestId },
    });
  }
}
