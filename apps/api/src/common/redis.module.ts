import { Global, Inject, Injectable, Module, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { RateLimiter, createRedisClient } from '@gateway/security';
import { loadConfig } from '../config/env.js';

export const REDIS_CLIENT = 'REDIS_CLIENT';
export const RATE_LIMITER = 'RATE_LIMITER';

@Injectable()
export class RedisLifecycle implements OnModuleInit, OnModuleDestroy {
  constructor(@Inject(REDIS_CLIENT) private readonly client: Redis) {}

  /**
   * `createRedisClient` uses `lazyConnect: true` precisely so this can await
   * the attempt - a bad `REDIS_URL` fails startup, not the first
   * rate-limited request.
   *
   * Calling `.connect()` unconditionally is only safe if nothing else has
   * touched this client yet. In practice something can: `main.ts` starts
   * `startDependencyHealthGauge`'s Redis `ping()` check before `app.listen()`
   * (deliberately, so the metrics port is up early), and ioredis's
   * `enableOfflineQueue` default means issuing a command on a still-lazy
   * client triggers its own implicit `connect()`. If that implicit connect
   * is still in flight when Nest runs this hook, ioredis rejects a second
   * `.connect()` call outright with "Redis is already connecting/connected",
   * which crashed startup 100% of the time with metrics enabled. Only call
   * `.connect()` from the client's initial `'wait'` state; otherwise wait for
   * whichever attempt is already underway to finish.
   */
  async onModuleInit(): Promise<void> {
    if (this.client.status === 'wait') {
      await this.client.connect();
      return;
    }
    if (this.client.status === 'ready') return;
    await new Promise<void>((resolve, reject) => {
      this.client.once('ready', resolve);
      this.client.once('error', reject);
    });
  }

  /**
   * `quit()` throws synchronously - not a rejected promise, an actual thrown
   * `Error` - when ioredis's connection is already in `'close'`/`'end'`
   * state (observed in practice: a graceful shutdown whose Redis connection
   * had already dropped, e.g. an idle connection the server or an
   * intermediate proxy closed). Uncaught, that throw becomes an unhandled
   * rejection inside Nest's `onModuleDestroy` hook runner and crashes the
   * process instead of exiting cleanly - the opposite of what a graceful
   * shutdown is for. The connection being gone already is not a failure to
   * report; it is `quit()`'s own goal, arrived at by another path.
   */
  async onModuleDestroy(): Promise<void> {
    if (this.client.status === 'end' || this.client.status === 'close') return;
    try {
      await this.client.quit();
    } catch (error) {
      if (!(error instanceof Error) || !/connection is closed/i.test(error.message)) throw error;
    }
  }
}

/**
 * Global for the same reason `PrismaModule` is: one connection, reachable
 * from every feature module without each one re-importing this. See
 * `PrismaModule`'s comment for why `loadConfig()` is called directly here
 * rather than injecting `APP_CONFIG`.
 */
@Global()
@Module({
  providers: [
    {
      provide: REDIS_CLIENT,
      useFactory: (): Redis => {
        const config = loadConfig();
        return createRedisClient({ url: config.redisUrl, db: config.redisCacheDb });
      },
    },
    RedisLifecycle,
    {
      provide: RATE_LIMITER,
      useFactory: (client: Redis): RateLimiter => new RateLimiter(client),
      inject: [REDIS_CLIENT],
    },
  ],
  exports: [REDIS_CLIENT, RATE_LIMITER],
})
export class RedisModule {}
