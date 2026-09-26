import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';

import type { Env } from '../../config/env';

export const REDIS_CLIENT = Symbol('REDIS_CLIENT');

/**
 * Shared Redis connection for caching, rate limiting and health checks. BullMQ opens its own
 * connections (blocking commands need dedicated sockets), so this one can fail fast: with the
 * offline queue disabled, commands error immediately while Redis is unreachable instead of
 * piling up behind a reconnect.
 */
@Global()
@Module({
  providers: [
    {
      provide: REDIS_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) =>
        new Redis(config.get('REDIS_URL', { infer: true }), {
          enableOfflineQueue: false,
          maxRetriesPerRequest: 1,
          connectionName: 'forge-api',
        }),
    },
  ],
  exports: [REDIS_CLIENT],
})
export class RedisModule implements OnApplicationShutdown {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async onApplicationShutdown(): Promise<void> {
    if (this.redis.status === 'ready') {
      await this.redis.quit();
    } else {
      this.redis.disconnect();
    }
  }
}
