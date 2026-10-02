import { Module } from '@nestjs/common';

import { SprintsModule } from '../sprints/sprints.module';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';

@Module({
  imports: [SprintsModule],
  controllers: [DashboardController],
  providers: [DashboardService],
})
export class DashboardModule {}
