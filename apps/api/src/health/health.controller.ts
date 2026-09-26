import { type ReadinessResponse } from '@forge/types';
import { Controller, Get, HttpCode, HttpStatus, Res } from '@nestjs/common';
import { ApiOkResponse, ApiServiceUnavailableResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';

import { Public } from '../auth/decorators';
import { SkipRateLimit } from '../rate-limit/rate-limit.decorator';
import { HealthService } from './health.service';

/** Probed by the load balancer and orchestrator: unauthenticated and never rate limited. */
@Public()
@SkipRateLimit()
@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  /** Liveness: the process is up and the event loop responds. Never checks dependencies. */
  @Get('live')
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ description: 'Process is running' })
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  /** Readiness: dependencies needed to serve traffic are reachable. 503 takes the task out of rotation. */
  @Get('ready')
  @ApiOkResponse({ description: 'All dependencies reachable' })
  @ApiServiceUnavailableResponse({ description: 'At least one dependency is unreachable' })
  async ready(@Res({ passthrough: true }) res: Response): Promise<ReadinessResponse> {
    const result = await this.health.readiness();
    res.status(result.status === 'ok' ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    return result;
  }
}
