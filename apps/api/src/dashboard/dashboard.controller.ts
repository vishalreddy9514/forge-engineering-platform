import { DashboardQuery, type ProjectDashboard } from '@forge/types';
import { Controller, Get, Param } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import { RequireProjectPermission } from '../access-control/require-project-permission.decorator';
import { ZodQuery } from '../common/http/zod';
import { DashboardService } from './dashboard.service';

@ApiTags('dashboard')
@ApiBearerAuth()
@Controller()
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get('projects/:projectId/dashboard')
  @RequireProjectPermission('project:read')
  get(
    @Param('projectId') projectId: string,
    @ZodQuery(DashboardQuery) query: DashboardQuery,
  ): Promise<ProjectDashboard> {
    return this.dashboard.project(projectId, query.weeks);
  }
}
