import { type DynamicModule, Module } from '@nestjs/common';

import { MetricsServer } from './metrics.server';
import { QueueDepthCollector } from './queue-depth.collector';

/** Metrics endpoint for the process, plus queue depth in the worker (architecture §11). */
@Module({})
export class ObservabilityModule {
  static forRoot(role: 'api' | 'worker'): DynamicModule {
    return {
      module: ObservabilityModule,
      providers: role === 'worker' ? [MetricsServer, QueueDepthCollector] : [MetricsServer],
    };
  }
}
