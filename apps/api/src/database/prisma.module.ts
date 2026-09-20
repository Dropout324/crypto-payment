import { Global, Inject, Injectable, Module, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { type DatabaseClient, createPrismaClient } from '@gateway/database';
import { loadConfig } from '../config/env.js';

export const PRISMA_CLIENT = 'PRISMA_CLIENT';

@Injectable()
export class PrismaLifecycle implements OnModuleInit, OnModuleDestroy {
  constructor(@Inject(PRISMA_CLIENT) private readonly client: DatabaseClient) {}

  async onModuleInit(): Promise<void> {
    await this.client.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.$disconnect();
  }
}

/**
 * Global so every feature module can `@Inject(PRISMA_CLIENT)` without each one
 * re-importing this module - the connection pool is process-wide by design.
 *
 * Calls `loadConfig()` directly rather than injecting the `APP_CONFIG`
 * provider: `@Global()` makes THIS module's exports reachable from anywhere,
 * but does not reach the other way around - `APP_CONFIG` (provided by
 * `AppModule`) is not visible inside `PrismaModule`'s own DI context unless
 * `AppModule` is imported here too, which would be circular.
 */
@Global()
@Module({
  providers: [
    {
      provide: PRISMA_CLIENT,
      useFactory: (): DatabaseClient => createPrismaClient({ databaseUrl: loadConfig().databaseUrl }),
    },
    PrismaLifecycle,
  ],
  exports: [PRISMA_CLIENT],
})
export class PrismaModule {}
