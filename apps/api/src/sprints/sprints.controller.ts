import {
  type Burndown,
  CompleteSprintRequest,
  CreateSprintRequest,
  type Sprint,
  SprintIssuesRequest,
  UpdateSprintRequest,
  type Velocity,
  VelocityQuery,
} from '@forge/types';
import { Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import { RequireProjectPermission } from '../access-control/require-project-permission.decorator';
import type { AuthUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators';
import { ApiZodBody, ZodBody, ZodQuery } from '../common/http/zod';
import { type CompletionSummary, SprintsService } from './sprints.service';

@ApiTags('sprints')
@ApiBearerAuth()
@Controller()
export class SprintsController {
  constructor(private readonly sprints: SprintsService) {}

  @Get('projects/:projectId/sprints')
  @RequireProjectPermission('project:read')
  list(@Param('projectId') projectId: string): Promise<Sprint[]> {
    return this.sprints.list(projectId);
  }

  @Post('projects/:projectId/sprints')
  @RequireProjectPermission('sprint:manage')
  @ApiZodBody(CreateSprintRequest)
  create(
    @Param('projectId') projectId: string,
    @ZodBody(CreateSprintRequest) body: CreateSprintRequest,
  ): Promise<Sprint> {
    return this.sprints.create(projectId, body);
  }

  @Get('projects/:projectId/velocity')
  @RequireProjectPermission('project:read')
  velocity(
    @Param('projectId') projectId: string,
    @ZodQuery(VelocityQuery) query: VelocityQuery,
  ): Promise<Velocity> {
    return this.sprints.velocity(projectId, query.sprints);
  }

  @Get('sprints/:sprintId')
  @RequireProjectPermission('project:read', 'sprint')
  get(@Param('sprintId') sprintId: string): Promise<Sprint> {
    return this.sprints.get(sprintId);
  }

  @Patch('sprints/:sprintId')
  @RequireProjectPermission('sprint:manage', 'sprint')
  @ApiZodBody(UpdateSprintRequest)
  update(
    @Param('sprintId') sprintId: string,
    @ZodBody(UpdateSprintRequest) body: UpdateSprintRequest,
  ): Promise<Sprint> {
    return this.sprints.update(sprintId, body);
  }

  @Delete('sprints/:sprintId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireProjectPermission('sprint:manage', 'sprint')
  async delete(@Param('sprintId') sprintId: string, @CurrentUser() user: AuthUser): Promise<void> {
    await this.sprints.delete(sprintId, user);
  }

  @Post('sprints/:sprintId/start')
  @HttpCode(HttpStatus.OK)
  @RequireProjectPermission('sprint:manage', 'sprint')
  start(@Param('sprintId') sprintId: string, @CurrentUser() user: AuthUser): Promise<Sprint> {
    return this.sprints.start(sprintId, user);
  }

  @Post('sprints/:sprintId/complete')
  @HttpCode(HttpStatus.OK)
  @RequireProjectPermission('sprint:manage', 'sprint')
  @ApiZodBody(CompleteSprintRequest)
  complete(
    @Param('sprintId') sprintId: string,
    @ZodBody(CompleteSprintRequest) body: CompleteSprintRequest,
    @CurrentUser() user: AuthUser,
  ): Promise<CompletionSummary> {
    return this.sprints.complete(sprintId, body, user);
  }

  @Post('sprints/:sprintId/issues')
  @HttpCode(HttpStatus.OK)
  @RequireProjectPermission('sprint:manage', 'sprint')
  @ApiZodBody(SprintIssuesRequest)
  addIssues(
    @Param('sprintId') sprintId: string,
    @ZodBody(SprintIssuesRequest) body: SprintIssuesRequest,
    @CurrentUser() user: AuthUser,
  ): Promise<Sprint> {
    return this.sprints.addIssues(sprintId, body.issueIds, user);
  }

  @Delete('sprints/:sprintId/issues/:issueId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireProjectPermission('sprint:manage', 'sprint')
  async removeIssue(
    @Param('sprintId') sprintId: string,
    @Param('issueId') issueId: string,
    @CurrentUser() user: AuthUser,
  ): Promise<void> {
    await this.sprints.removeIssue(sprintId, issueId, user);
  }

  @Get('sprints/:sprintId/burndown')
  @RequireProjectPermission('project:read', 'sprint')
  burndown(@Param('sprintId') sprintId: string): Promise<Burndown> {
    return this.sprints.burndown(sprintId);
  }
}
