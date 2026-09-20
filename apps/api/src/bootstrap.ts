import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import helmet from '@fastify/helmet';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  REQUEST_ID_HEADER,
  UNMATCHED_ROUTE,
  createHttpMetrics,
  resolveRequestId,
  runWithRequestContext,
  type Logger,
  type Registry,
} from '@gateway/observability';
import { AppModule } from './app.module.js';
import { AppExceptionFilter } from './common/http-exception.filter.js';
import { PinoNestLogger } from './common/pino-nest-logger.js';
import { loadConfig } from './config/env.js';

export interface CreateAppOptions {
  /** Routes Nest's own logging through pino and enables request-id propagation + HTTP metrics. Omitted in the e2e test harness (create-test-app.ts), which has its own minimal setup. */
  observability?: { logger: Logger; registry: Registry };
}

/**
 * Builds and fully configures the Nest application without calling
 * `listen()`. Shared by `main.ts` (which listens on a real port) and the
 * integration tests (which drive the app directly via supertest), so the
 * pipes/filters/plugins under test are exactly what production runs.
 */
export async function createApp(options: CreateAppOptions = {}): Promise<NestFastifyApplication> {
  const config = loadConfig();

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    // `request.ip` (used for rate-limit keys and API-key IP allowlisting)
    // reflects the immediate socket peer unless this is enabled - which is
    // the load balancer, not the merchant's server, once this runs behind
    // one. RATE_LIMIT_TRUST_PROXY must only be true behind a proxy that
    // itself strips/overwrites any client-supplied X-Forwarded-For.
    //
    // `skipMiddie: true`: without it, Nest's Fastify adapter unconditionally
    // registers `@fastify/middie` on `app.init()` (see its `registerMiddie()`
    // call site), even though this app never calls `app.use()` with
    // Express-style middleware. `@fastify/middie` has had a critical
    // middleware-authentication-bypass advisory (GHSA-72c6-fx6q-fr5w) plus
    // several path-normalization-bypass ones; skipping its registration
    // entirely removes that surface rather than depending on Nest to bump a
    // transitive dependency.
    new FastifyAdapter({ trustProxy: config.rateLimitTrustProxy, skipMiddie: true }),
    {
      bufferLogs: true,
      // Nest's Fastify adapter otherwise registers its own default JSON body
      // parser during app.init() (triggered by listen()), which collides with
      // the custom bodyLimit-enforcing parser registered below.
      bodyParser: false,
    },
  );

  if (options.observability) {
    // `bufferLogs: true` above holds Nest's own startup log lines until this
    // runs, so they go through pino too instead of Nest's default formatter.
    app.useLogger(new PinoNestLogger(options.observability.logger));
    // `getInstance()` is typed against @nestjs/platform-fastify's OWN bundled
    // fastify (4.x - see docs/decisions/0016-security-testing.md and the
    // README's "out of scope" note on the fastify 4/5 split), which is
    // structurally close to but not identical to apps/api's own `fastify`
    // (5.x) package that `FastifyRequest`/`FastifyReply` below come from -
    // hence the cast rather than a directly-assignable type.
    registerHttpObservability(app.getHttpAdapter().getInstance() as unknown as PlatformFastifyInstance, options.observability);
  }

  await app.register(helmet as never);
  await app.register(cors as never, {
    origin: config.corsAllowedOrigins,
    credentials: true,
    // @fastify/cors@11 defaults `methods` to 'GET,HEAD,POST' - every method
    // this API actually exposes must be listed explicitly, or the browser's
    // own preflight silently blocks it before the request ever reaches a
    // route (no server-side log, no application error - Phase 18's PATCH
    // and DELETE dashboard actions, e.g. toggling a webhook or removing a
    // team member, failed exactly this way until this was added).
    methods: ['GET', 'HEAD', 'POST', 'PATCH', 'DELETE'],
  });
  await app.register(cookie as never);

  app.useGlobalFilters(new AppExceptionFilter());
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      disableErrorMessages: false,
    }),
  );

  app.getHttpAdapter().getInstance().addContentTypeParser(
    'application/json',
    { parseAs: 'string', bodyLimit: 256 * 1024 },
    (_req, body, done) => {
      try {
        done(null, JSON.parse(body as string));
      } catch (error) {
        done(error as Error, undefined);
      }
    },
  );

  return app;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the `onRequest` hook below; read by the exception filter so every error response's `request_id` matches its log lines. */
    requestId?: string;
  }
}

/**
 * Two fastify hooks, registered once, that give every request an id
 * (adopted from `X-Request-Id` when the caller supplied a well-formed one,
 * else generated) and record it in HTTP metrics:
 *
 * - `onRequest` resolves the id, echoes it on the response, and runs the
 *   rest of the request inside `runWithRequestContext` so every log line
 *   written anywhere during the request - controllers, services, the
 *   exception filter - carries it without threading it through explicitly.
 * - `onResponse` fires after the response has been sent either way (Fastify
 *   guarantees this hook runs even when a handler throws), so every request
 *   is counted exactly once, error or success.
 *
 * The route *template* (`request.routeOptions.url`, e.g.
 * `/v1/payment-invoices/:id`), never `request.url`, labels the metric - the
 * raw path would give every distinct invoice id its own time series.
 */
/** The shape `app.getHttpAdapter().getInstance()` actually returns - see the cast at its one call site above for why this isn't just `FastifyInstance` from `fastify`. */
type PlatformFastifyInstance = {
  addHook(
    name: 'onRequest' | 'onResponse',
    hook: (request: FastifyRequest, reply: FastifyReply, done: () => void) => void,
  ): unknown;
};

function registerHttpObservability(
  instance: PlatformFastifyInstance,
  observability: { logger: Logger; registry: Registry },
): void {
  const http = createHttpMetrics(observability.registry);

  instance.addHook('onRequest', (request: FastifyRequest, reply: FastifyReply, done: () => void) => {
    const requestId = resolveRequestId(request.headers[REQUEST_ID_HEADER]);
    request.requestId = requestId;
    reply.header(REQUEST_ID_HEADER, requestId);
    http.inFlight.inc();
    runWithRequestContext({ requestId }, done);
  });

  instance.addHook('onResponse', (request: FastifyRequest, reply: FastifyReply, done: () => void) => {
    http.inFlight.dec();
    http.observe({
      method: request.method,
      route: request.routeOptions?.url ?? UNMATCHED_ROUTE,
      statusCode: reply.statusCode,
      durationSeconds: reply.elapsedTime / 1000,
    });
    done();
  });
}
