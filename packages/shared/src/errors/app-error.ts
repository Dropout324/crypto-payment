/**
 * Machine-readable error codes. Merchants integrate against these strings, so
 * they are part of the public API contract: add freely, never repurpose.
 */
export const ErrorCode = {
  // 400
  VALIDATION_FAILED: 'validation_failed',
  INVALID_AMOUNT: 'invalid_amount',
  INVALID_ADDRESS: 'invalid_address',
  UNSUPPORTED_ASSET: 'unsupported_asset',
  UNSUPPORTED_NETWORK: 'unsupported_network',
  NETWORK_LIVEMODE_MISMATCH: 'network_livemode_mismatch',
  INVALID_STATE_TRANSITION: 'invalid_state_transition',
  // 401 / 403
  UNAUTHENTICATED: 'unauthenticated',
  INVALID_CREDENTIALS: 'invalid_credentials',
  API_KEY_REVOKED: 'api_key_revoked',
  API_KEY_EXPIRED: 'api_key_expired',
  FORBIDDEN: 'forbidden',
  IP_NOT_ALLOWED: 'ip_not_allowed',
  // 404
  NOT_FOUND: 'not_found',
  // 409
  CONFLICT: 'conflict',
  DUPLICATE_ORDER_ID: 'duplicate_order_id',
  IDEMPOTENCY_KEY_REUSED: 'idempotency_key_reused',
  IDEMPOTENT_REQUEST_IN_FLIGHT: 'idempotent_request_in_flight',
  INVOICE_NOT_CANCELLABLE: 'invoice_not_cancellable',
  // 422
  RATE_UNAVAILABLE: 'rate_unavailable',
  RATE_STALE: 'rate_stale',
  ADDRESS_POOL_EXHAUSTED: 'address_pool_exhausted',
  COMPLIANCE_REVIEW_REQUIRED: 'compliance_review_required',
  SIGNING_CEILING_EXCEEDED: 'signing_ceiling_exceeded',
  SIGNING_NOT_CONFIGURED: 'signing_not_configured',
  // 429
  RATE_LIMITED: 'rate_limited',
  // 500+
  INTERNAL_ERROR: 'internal_error',
  UPSTREAM_UNAVAILABLE: 'upstream_unavailable',
  LEDGER_IMBALANCE: 'ledger_imbalance',
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

export interface AppErrorOptions {
  /** Structured, SAFE-to-return context. Never put secrets or PII here. */
  details?: Record<string, unknown>;
  /** Underlying cause, kept for logs only — never serialised to the client. */
  cause?: unknown;
  /** Expected failure (`true`) vs. a bug/outage worth paging on (`false`). */
  operational?: boolean;
}

export class AppError extends Error {
  readonly code: ErrorCodeValue;
  readonly httpStatus: number;
  readonly details: Record<string, unknown> | undefined;
  readonly operational: boolean;
  override readonly cause: unknown;

  constructor(
    code: ErrorCodeValue,
    httpStatus: number,
    message: string,
    options: AppErrorOptions = {},
  ) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.httpStatus = httpStatus;
    this.details = options.details;
    this.operational = options.operational ?? true;
    this.cause = options.cause;
    Error.captureStackTrace?.(this, new.target);
  }

  /** The exact body shape returned to API clients. */
  toPublicJSON(requestId?: string): {
    error: { code: string; message: string; details?: Record<string, unknown>; request_id?: string };
  } {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details ? { details: this.details } : {}),
        ...(requestId ? { request_id: requestId } : {}),
      },
    };
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(ErrorCode.VALIDATION_FAILED, 400, message, details ? { details } : {});
  }
}

export class UnauthenticatedError extends AppError {
  constructor(message = 'Authentication required', code: ErrorCodeValue = ErrorCode.UNAUTHENTICATED) {
    super(code, 401, message);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Insufficient permissions', details?: Record<string, unknown>) {
    super(ErrorCode.FORBIDDEN, 403, message, details ? { details } : {});
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string, id?: string) {
    super(ErrorCode.NOT_FOUND, 404, `${resource} not found`, id ? { details: { id } } : {});
  }
}

export class ConflictError extends AppError {
  constructor(
    message: string,
    code: ErrorCodeValue = ErrorCode.CONFLICT,
    details?: Record<string, unknown>,
  ) {
    super(code, 409, message, details ? { details } : {});
  }
}

export class UnprocessableError extends AppError {
  constructor(code: ErrorCodeValue, message: string, details?: Record<string, unknown>) {
    super(code, 422, message, details ? { details } : {});
  }
}

export class RateLimitError extends AppError {
  readonly retryAfterSeconds: number;
  constructor(retryAfterSeconds: number, message = 'Too many requests') {
    super(ErrorCode.RATE_LIMITED, 429, message, { details: { retry_after: retryAfterSeconds } });
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class InternalError extends AppError {
  constructor(message = 'Internal server error', cause?: unknown) {
    super(ErrorCode.INTERNAL_ERROR, 500, message, { cause, operational: false });
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}
