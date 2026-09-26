import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';

import { REDIS_CLIENT } from '../infrastructure/redis/redis.module';
import type { HealthIndicator } from './health-indicator';

@Injectable()
export class RedisHealthIndicator implements HealthIndicator {
  readonly name = 'redis';

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async check(): Promise<void> {
    // Rejects when the connection is down (the offline queue is disabled on this client).
    await this.redis.ping();
  }
}
