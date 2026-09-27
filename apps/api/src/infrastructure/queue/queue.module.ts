import { BullModule } from '@nestjs/bullmq';
import { type DynamicModule, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { Env } from '../../config/env';

/** Queue names, shared by producers (API) and processors (worker). */
export const QUEUES = {
  EMAIL: 'email',
  NOTIFICATIONS: 'notifications',
  MAINTENANCE: 'maintenance',
  GITHUB: 'github',
} as const;

/**
 * BullMQ connection settings differ by role:
 * - producers (API) fail fast when Redis is down, so a request errors instead of hanging;
 * - workers use `maxRetriesPerRequest: null`, which BullMQ requires for blocking reads.
 */
@Module({})
export class QueueModule {
  static forRoot(role: 'producer' | 'worker'): DynamicModule {
    return {
      module: QueueModule,
      imports: [
        BullModule.forRootAsync({
          inject: [ConfigService],
          useFactory: (config: ConfigService<Env, true>) => {
            const url: string = config.get('REDIS_URL', { infer: true });
            return {
              prefix: 'forge',
              connection: {
                url,
                ...(role === 'producer'
                  ? { enableOfflineQueue: false, maxRetriesPerRequest: 1 }
                  : { maxRetriesPerRequest: null }),
              },
            };
          },
        }),
      ],
    };
  }
}
