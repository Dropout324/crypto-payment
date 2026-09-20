import { Prisma, PrismaClient } from '@prisma/client';

export { Prisma, PrismaClient };
export * from '@prisma/client';

export type DatabaseClient = PrismaClient;

/**
 * A handle that is either the pooled client or an open interaction transaction.
 * Repository functions accept this so the same code runs inside or outside a
 * transaction - which matters because every money-touching operation must be
 * composable into a single atomic unit.
 */
export type TransactionClient = Omit<
  PrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;

export type Executor = DatabaseClient | TransactionClient;

export interface CreateClientOptions {
  databaseUrl?: string;
  /** Emit query events for the logger. Never enable in production: query text
   *  can contain merchant data. */
  logQueries?: boolean;
}

export function createPrismaClient(options: CreateClientOptions = {}): PrismaClient {
  const databaseUrl = options.databaseUrl ?? process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is not set');
  }

  return new PrismaClient({
    datasources: { db: { url: databaseUrl } },
    log: options.logQueries
      ? [
          { emit: 'event', level: 'query' },
          { emit: 'event', level: 'warn' },
          { emit: 'event', level: 'error' },
        ]
      : [
          { emit: 'event', level: 'warn' },
          { emit: 'event', level: 'error' },
        ],
  });
}

/**
 * Isolation level for anything that reads a balance or an invoice state and
 * then writes based on it.
 *
 * Serializable, not the Postgres default: the payment path is full of
 * read-modify-write races (two workers crediting the same invoice, an expiry
 * sweeper racing a confirmation). Serializable turns those into retryable
 * errors instead of silent corruption. Callers must handle P2034.
 */
export const FINANCIAL_ISOLATION = Prisma.TransactionIsolationLevel.Serializable;

/** Postgres/Prisma codes that mean "you lost a race, try again". */
const RETRYABLE_CODES = new Set(['P2034', '40001', '40P01']);

export function isRetryableTransactionError(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (RETRYABLE_CODES.has(error.code)) return true;
    const pgCode = (error.meta as { code?: string } | undefined)?.code;
    if (pgCode && RETRYABLE_CODES.has(pgCode)) return true;
  }
  return false;
}

export interface RunInTransactionOptions {
  maxRetries?: number;
  timeoutMs?: number;
  maxWaitMs?: number;
  isolationLevel?: Prisma.TransactionIsolationLevel;
  /** Called before each retry, for metrics and logging. */
  onRetry?: (attempt: number, error: unknown) => void;
}

/**
 * Run `fn` in a serializable transaction, retrying serialization failures with
 * jittered backoff. Any other error propagates and rolls the transaction back.
 */
export async function runInTransaction<T>(
  client: DatabaseClient,
  fn: (tx: TransactionClient) => Promise<T>,
  options: RunInTransactionOptions = {},
): Promise<T> {
  // 3 was not enough headroom: phase 9 load testing found sustained
  // concurrent writers against one hot row/predicate (many logins for the
  // same user, many invoice creations for the same merchant's address pool)
  // exhausting 3 retries and surfacing as opaque 500s to a large fraction of
  // requests (see docs/decisions/0015-load-testing.md). 8 keeps the
  // worst-case added latency bounded (backoff is capped at 500ms/attempt)
  // while giving contended transactions enough chances to land.
  const maxRetries = options.maxRetries ?? 8;
  const isolationLevel = options.isolationLevel ?? FINANCIAL_ISOLATION;

  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return await client.$transaction(fn, {
        isolationLevel,
        timeout: options.timeoutMs ?? 15_000,
        maxWait: options.maxWaitMs ?? 5_000,
      });
    } catch (error) {
      if (!isRetryableTransactionError(error) || attempt === maxRetries) {
        throw error;
      }
      lastError = error;
      options.onRetry?.(attempt + 1, error);
      // Exponential backoff with jitter, so retrying workers do not resynchronise.
      const backoffMs = Math.min(2 ** attempt * 25, 500) + Math.random() * 25;
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }
  }

  throw lastError;
}

/**
 * Take a Postgres advisory lock for the duration of `tx`.
 *
 * Used where a row lock is not enough because the thing being serialised does
 * not exist yet - deriving the next deposit address for a wallet account, or
 * running one settlement batch per merchant at a time.
 */
export async function withAdvisoryLock<T>(
  tx: TransactionClient,
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  // Hash the key to the bigint pg_advisory_xact_lock expects. The lock is
  // released automatically when the transaction ends, including on rollback.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key})::bigint)`;
  return fn();
}
