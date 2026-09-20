import { Redis } from 'ioredis';

/**
 * Redis-backed fixed-window rate limiter (Phase 8).
 *
 * A fixed window (rather than a sliding one) is deliberate: it is a single
 * atomic `INCR`+`PEXPIRE`, so it stays correct under concurrent requests from
 * many API replicas without a lock, at the cost of allowing up to `2x limit`
 * requests across a window boundary. That trade-off is acceptable for abuse
 * throttling (login brute force, invoice-creation spam) - it is not a
 * billing meter, so exactness at the boundary does not matter.
 *
 * `INCR` and `PEXPIRE` are combined into one `EVAL` because two separate
 * round trips would leave a key with no TTL (and therefore no reset, ever)
 * if the process crashed between them.
 */
const FIXED_WINDOW_SCRIPT = `
local current = redis.call('INCR', KEYS[1])
if current == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
local ttl = redis.call('PTTL', KEYS[1])
return { current, ttl }
`;

export interface RateLimitResult {
  allowed: boolean;
  /** Requests still permitted in the current window; never negative. */
  remaining: number;
  /** Seconds until the window resets. Always at least 1. */
  retryAfterSeconds: number;
}

export interface RedisClientOptions {
  url: string;
  /** Logical Redis database index (`SELECT`), not a separate connection pool. */
  db?: number;
}

/**
 * Creates the shared client used for rate limiting (and, later, other
 * cache-shaped uses of `REDIS_CACHE_DB`). `lazyConnect: true` so the caller
 * controls exactly when the connection attempt happens and can await it -
 * mirrors `createPrismaClient`'s eager, awaited `$connect()` so a
 * misconfigured `REDIS_URL` fails API startup instead of the first request.
 */
export function createRedisClient(options: RedisClientOptions): Redis {
  return new Redis(options.url, {
    db: options.db,
    lazyConnect: true,
    maxRetriesPerRequest: 3,
  });
}

/** Minimal surface `RateLimiter` needs - narrower than the full `ioredis` client, so tests can substitute a fake. */
export interface RateLimiterRedis {
  eval(script: string, numKeys: number, ...args: Array<string | number>): Promise<unknown>;
}

export class RateLimiter {
  constructor(private readonly redis: RateLimiterRedis) {}

  /**
   * Increments `key`'s counter for this window and reports whether the
   * caller is still under `limit`. The counter itself is never rolled back
   * on rejection - a rejected request still consumed a slot, which is what
   * makes this a limiter rather than a queue.
   */
  async consume(key: string, limit: number, windowSeconds: number): Promise<RateLimitResult> {
    const windowMs = windowSeconds * 1000;
    const [current, ttlMs] = (await this.redis.eval(FIXED_WINDOW_SCRIPT, 1, key, windowMs)) as [number, number];

    const retryAfterSeconds = Math.max(1, Math.ceil((ttlMs > 0 ? ttlMs : windowMs) / 1000));
    return {
      allowed: current <= limit,
      remaining: Math.max(0, limit - current),
      retryAfterSeconds,
    };
  }
}
