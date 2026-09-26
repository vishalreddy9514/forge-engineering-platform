import { Module } from '@nestjs/common';

import { HealthController } from './health.controller';
import { HEALTH_INDICATORS, type HealthIndicator } from './health-indicator';
import { HealthService } from './health.service';
import { RedisHealthIndicator } from './redis.health';

@Module({
  controllers: [HealthController],
  providers: [
    HealthService,
    RedisHealthIndicator,
    {
      provide: HEALTH_INDICATORS,
      inject: [RedisHealthIndicator],
      useFactory: (...indicators: HealthIndicator[]) => indicators,
    },
  ],
})
export class HealthModule {}
