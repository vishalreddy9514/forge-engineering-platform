import {
  CreateProjectRequest,
  type CursorPage,
  ListProjectsQuery,
  type ProjectDetail,
  type ProjectSummary,
  UpdateProjectRequest,
} from '@forge/types';
import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiQuery, ApiTags } from '@nestjs/swagger';

import type { ProjectAccess } from '../access-control/project-access.guard';
import { CurrentProjectAccess } from '../access-control/project-access.decorator';
import { RequireProjectPermission } from '../access-control/require-project-permission.decorator';
import { AdminGuard } from '../admin/admin.guard';
import type { AuthUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators';
import { ReqMeta, type RequestMeta } from '../common/http/request-meta';
import { ApiZodBody, ZodBody, ZodQuery } from '../common/http/zod';
import { ProjectsService } from './projects.service';

@ApiTags('projects')
@ApiBearerAuth()
@Controller('projects')
export class ProjectsController {
  constructor(private readonly projects: ProjectsService) {}

  @Get()
  list(
    @CurrentUser() user: AuthUser,
    @ZodQuery(ListProjectsQuery) query: ListProjectsQuery,
  ): Promise<CursorPage<ProjectSummary>> {
    return this.projects.list(user, query);
  }

  /** Any signed-in user can start a project and becomes its first project manager. */
  @Post()
  @ApiZodBody(CreateProjectRequest)
  create(
    @ZodBody(CreateProjectRequest) body: CreateProjectRequest,
    @CurrentUser() user: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ): Promise<ProjectDetail> {
    return this.projects.create(body, user, meta);
  }

  /** The web app addresses projects by key (/projects/PAY). */
  @Get('by-key/:projectKey')
  @RequireProjectPermission('project:read', 'projectKey', 'projectKey')
  getByKey(
    @CurrentProjectAccess() access: ProjectAccess,
    @CurrentUser() user: AuthUser,
  ): Promise<ProjectDetail> {
    return this.projects.get(access.projectId, user);
  }

  @Get(':projectId')
  @RequireProjectPermission('project:read')
  get(
    @CurrentProjectAccess() access: ProjectAccess,
    @CurrentUser() user: AuthUser,
  ): Promise<ProjectDetail> {
    return this.projects.get(access.projectId, user);
  }

  @Patch(':projectId')
  @RequireProjectPermission('project:update')
  @ApiZodBody(UpdateProjectRequest)
  update(
    @CurrentProjectAccess() access: ProjectAccess,
    @ZodBody(UpdateProjectRequest) body: UpdateProjectRequest,
    @CurrentUser() user: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ): Promise<ProjectDetail> {
    return this.projects.update(access.projectId, body, user, meta);
  }

  @Post(':projectId/archive')
  @HttpCode(HttpStatus.OK)
  @RequireProjectPermission('project:archive')
  archive(
    @CurrentProjectAccess() access: ProjectAccess,
    @CurrentUser() user: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ): Promise<ProjectDetail> {
    return this.projects.setArchived(access.projectId, true, user, meta);
  }

  @Post(':projectId/restore')
  @HttpCode(HttpStatus.OK)
  @RequireProjectPermission('project:archive')
  restore(
    @CurrentProjectAccess() access: ProjectAccess,
    @CurrentUser() user: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ): Promise<ProjectDetail> {
    return this.projects.setArchived(access.projectId, false, user, meta);
  }

  /** Platform admins only, and only for archived projects: `DELETE …?confirm=PAY`. */
  @Delete(':projectId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(AdminGuard)
  @ApiQuery({ name: 'confirm', description: 'The project key, repeated as a safety catch' })
  async delete(
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
    @Query('confirm') confirm: string | undefined,
    @CurrentUser() user: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ): Promise<void> {
    await this.projects.delete(projectId, confirm, user, meta);
  }
}
