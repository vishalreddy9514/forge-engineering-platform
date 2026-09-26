import { Module } from '@nestjs/common';

import { DatabaseHealthIndicator } from './database.health';
import { HealthController } from './health.controller';
import { HEALTH_INDICATORS, type HealthIndicator } from './health-indicator';
import { HealthService } from './health.service';
import { RedisHealthIndicator } from './redis.health';

@Module({
  controllers: [HealthController],
  providers: [
    HealthService,
    DatabaseHealthIndicator,
    RedisHealthIndicator,
    {
      provide: HEALTH_INDICATORS,
      inject: [DatabaseHealthIndicator, RedisHealthIndicator],
      useFactory: (...indicators: HealthIndicator[]) => indicators,
    },
  ],
})
export class HealthModule {}
