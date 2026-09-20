import { Controller, Get, HttpCode, Inject, ServiceUnavailableException } from '@nestjs/common';
import type { DatabaseClient } from '@gateway/database';
import type { Redis } from 'ioredis';
import { PRISMA_CLIENT } from '../database/prisma.module.js';
import { REDIS_CLIENT } from '../common/redis.module.js';

/**
 * `/v1/health` reports "the process is up" - no dependency checks, so a load
 * balancer's liveness probe cannot be starved by a slow database.
 * `/v1/ready` reports "this instance can actually serve traffic" - it checks
 * every dependency a request handler can actually block on: the database,
 * and Redis (`RateLimitGuard` sits in front of nearly every route and
 * depends on it completely - an unreachable Redis is not "degraded", it is
 * "cannot serve requests", exactly like an unreachable database). A 503 here
 * tells an orchestrator to stop routing to it.
 */
@Controller('v1')
export class HealthController {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly db: DatabaseClient,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  @Get('health')
  @HttpCode(200)
  health() {
    return { status: 'ok', timestamp: new Date().toISOString() };
  }

  @Get('ready')
  @HttpCode(200)
  async ready() {
    const [database, redis] = await Promise.allSettled([this.db.$queryRaw`SELECT 1`, this.redis.ping()]);

    if (database.status === 'rejected' || redis.status === 'rejected') {
      throw new ServiceUnavailableException({
        status: 'not_ready',
        checks: {
          database: database.status === 'fulfilled' ? 'ok' : 'unreachable',
          redis: redis.status === 'fulfilled' ? 'ok' : 'unreachable',
        },
      });
    }

    return { status: 'ready', timestamp: new Date().toISOString() };
  }
}
