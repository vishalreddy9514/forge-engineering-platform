import { type ReadinessResponse } from '@forge/types';
import { Inject, Injectable, Logger } from '@nestjs/common';

import { HEALTH_INDICATORS, type HealthIndicator } from './health-indicator';

export const HEALTH_CHECK_TIMEOUT_MS = 1_000;

type CheckResult = ReadinessResponse['checks'][string];

@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);

  constructor(@Inject(HEALTH_INDICATORS) private readonly indicators: HealthIndicator[]) {}

  /**
   * Runs all checks in parallel, each with a timeout, so one hung dependency cannot make the
   * readiness probe itself hang (the load balancer would then time out and guess).
   */
  async readiness(): Promise<ReadinessResponse> {
    const results = await Promise.all(
      this.indicators.map(async (indicator): Promise<[string, CheckResult]> => {
        try {
          await withTimeout(indicator.check(), HEALTH_CHECK_TIMEOUT_MS);
          return [indicator.name, { status: 'ok' }];
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.logger.warn({ check: indicator.name, message }, 'Readiness check failed');
          return [indicator.name, { status: 'error', message }];
        }
      }),
    );

    const checks: ReadinessResponse['checks'] = Object.fromEntries(results);
    const healthy = results.every(([, result]) => result.status === 'ok');
    return { status: healthy ? 'ok' : 'error', checks };
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`Timed out after ${ms} ms`));
    }, ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
