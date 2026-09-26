import { Injectable } from '@nestjs/common';

import { PrismaService } from '../infrastructure/database/prisma.service';
import type { HealthIndicator } from './health-indicator';

@Injectable()
export class DatabaseHealthIndicator implements HealthIndicator {
  readonly name = 'database';

  constructor(private readonly prisma: PrismaService) {}

  async check(): Promise<void> {
    await this.prisma.$queryRaw`SELECT 1`;
  }
}
