import {
  CreateIssueRequest,
  type CursorPage,
  type IssueDetail,
  type IssueEvent,
  type IssueSummary,
  ListIssuesQuery,
  parseIssueKey,
  UpdateIssueRequest,
} from '@forge/types';
import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import type { ProjectAccess } from '../access-control/project-access.guard';
import { CurrentProjectAccess } from '../access-control/project-access.decorator';
import { RequireProjectPermission } from '../access-control/require-project-permission.decorator';
import type { AuthUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators';
import { ApiZodBody, ZodBody, ZodQuery } from '../common/http/zod';
import { IssuesService } from './issues.service';

@ApiTags('issues')
@ApiBearerAuth()
@Controller()
export class IssuesController {
  constructor(private readonly issues: IssuesService) {}

  @Get('projects/:projectId/issues')
  @RequireProjectPermission('project:read')
  list(
    @CurrentProjectAccess() access: ProjectAccess,
    @ZodQuery(ListIssuesQuery) query: ListIssuesQuery,
    @CurrentUser() user: AuthUser,
  ): Promise<CursorPage<IssueSummary>> {
    return this.issues.list(access.projectId, query, user);
  }

  @Post('projects/:projectId/issues')
  @RequireProjectPermission('issue:create')
  @ApiZodBody(CreateIssueRequest)
  create(
    @CurrentProjectAccess() access: ProjectAccess,
    @ZodBody(CreateIssueRequest) body: CreateIssueRequest,
    @CurrentUser() user: AuthUser,
  ): Promise<IssueDetail> {
    return this.issues.create(access.projectId, body, user);
  }

  /** The web app addresses issues by key: /projects/PAY/issues/PAY-12. */
  @Get('issues/by-key/:issueKey')
  @RequireProjectPermission('project:read', 'issueKey', 'issueKey')
  getByKey(
    @CurrentProjectAccess() access: ProjectAccess,
    @Param('issueKey') issueKey: string,
  ): Promise<IssueDetail> {
    const key = parseIssueKey(issueKey);
    if (!key) throw new NotFoundException('Issue not found');
    return this.issues.getByKey(access.projectId, key.number);
  }

  @Get('issues/:issueId')
  @RequireProjectPermission('project:read', 'issue')
  get(@Param('issueId') issueId: string): Promise<IssueDetail> {
    return this.issues.get(issueId);
  }

  @Patch('issues/:issueId')
  @RequireProjectPermission('issue:update', 'issue')
  @ApiZodBody(UpdateIssueRequest)
  update(
    @Param('issueId') issueId: string,
    @ZodBody(UpdateIssueRequest) body: UpdateIssueRequest,
    @CurrentUser() user: AuthUser,
  ): Promise<IssueDetail> {
    return this.issues.update(issueId, body, user);
  }

  @Delete('issues/:issueId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireProjectPermission('issue:delete', 'issue')
  async delete(@Param('issueId') issueId: string, @CurrentUser() user: AuthUser): Promise<void> {
    await this.issues.delete(issueId, user);
  }

  /** Field-level change history (FR-4.7), oldest first. */
  @Get('issues/:issueId/events')
  @RequireProjectPermission('project:read', 'issue')
  events(@Param('issueId') issueId: string): Promise<IssueEvent[]> {
    return this.issues.events(issueId);
  }
}
