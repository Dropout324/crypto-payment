import type { LoggerService } from '@nestjs/common';
import type { Logger } from '@gateway/observability';

/**
 * Adapts the shared pino `Logger` to Nest's `LoggerService` interface, so
 * `NestFactory.create(..., { bufferLogs: true })` + `app.useLogger(...)`
 * routes Nest's own internal logging (module init, route mapping, lifecycle
 * events) through the same structured, redacted JSON sink as every
 * application-level log line - never Nest's default text formatter.
 */
export class PinoNestLogger implements LoggerService {
  constructor(private readonly logger: Logger) {}

  log(message: unknown, ...optionalParams: unknown[]): void {
    this.logger.info(context(optionalParams), asMessage(message));
  }

  error(message: unknown, ...optionalParams: unknown[]): void {
    this.logger.error(context(optionalParams), asMessage(message));
  }

  warn(message: unknown, ...optionalParams: unknown[]): void {
    this.logger.warn(context(optionalParams), asMessage(message));
  }

  debug(message: unknown, ...optionalParams: unknown[]): void {
    this.logger.debug(context(optionalParams), asMessage(message));
  }

  verbose(message: unknown, ...optionalParams: unknown[]): void {
    this.logger.trace(context(optionalParams), asMessage(message));
  }
}

function asMessage(message: unknown): string {
  return typeof message === 'string' ? message : JSON.stringify(message);
}

/** Nest passes a trailing "context" string (e.g. the class name) as the last optional param. */
function context(optionalParams: unknown[]): Record<string, unknown> {
  const nestContext = optionalParams[optionalParams.length - 1];
  return typeof nestContext === 'string' ? { nestContext } : {};
}
