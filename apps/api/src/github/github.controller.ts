import {
  ClaimInstallationRequest,
  type Commit,
  type CursorPage,
  type GithubInstallation,
  type GithubIssue,
  type GithubRepository,
  type GithubStatus,
  type IssueDevelopment,
  type LinkedRepository,
  LinkRepositoryRequest,
  ListCommitsQuery,
  ListGithubIssuesQuery,
  ListPullRequestsQuery,
  type PullRequest,
  type SyncRequested,
} from '@forge/types';
import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import { RequireProjectPermission } from '../access-control/require-project-permission.decorator';
import { AdminGuard } from '../admin/admin.guard';
import type { AuthUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators';
import { type RequestMeta, ReqMeta } from '../common/http/request-meta';
import { ApiZodBody, ZodBody, ZodQuery } from '../common/http/zod';
import { RateLimit } from '../rate-limit/rate-limit.decorator';
import { GithubService } from './github.service';

@ApiTags('github')
@ApiBearerAuth()
@Controller()
export class GithubController {
  constructor(private readonly github: GithubService) {}

  @Get('github/status')
  status(): GithubStatus {
    return this.github.status();
  }

  @Get('github/installations')
  @UseGuards(AdminGuard)
  installations(): Promise<GithubInstallation[]> {
    return this.github.listInstallations();
  }

  @Post('github/installations')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AdminGuard)
  @ApiZodBody(ClaimInstallationRequest)
  @RateLimit({ name: 'github-claim', limit: 10, windowSeconds: 60, by: 'user' })
  claim(
    @ZodBody(ClaimInstallationRequest) body: ClaimInstallationRequest,
    @CurrentUser() user: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ): Promise<GithubInstallation> {
    return this.github.claimInstallation(body.installationId, user, meta);
  }

  @Get('projects/:projectId/github/available-repositories')
  @RequireProjectPermission('github:link')
  available(@Param('projectId') projectId: string): Promise<GithubRepository[]> {
    return this.github.availableRepositories(projectId);
  }

  @Get('projects/:projectId/repositories')
  @RequireProjectPermission('project:read')
  repositories(@Param('projectId') projectId: string): Promise<LinkedRepository[]> {
    return this.github.linkedRepositories(projectId);
  }

  @Post('projects/:projectId/repositories')
  @RequireProjectPermission('github:link')
  @ApiZodBody(LinkRepositoryRequest)
  link(
    @Param('projectId') projectId: string,
    @ZodBody(LinkRepositoryRequest) body: LinkRepositoryRequest,
    @CurrentUser() user: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ): Promise<LinkedRepository> {
    return this.github.linkRepository(projectId, body.repositoryId, user, meta);
  }

  @Delete('projects/:projectId/repositories/:repositoryId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireProjectPermission('github:link')
  async unlink(
    @Param('projectId') projectId: string,
    @Param('repositoryId', new ParseUUIDPipe()) repositoryId: string,
    @CurrentUser() user: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ): Promise<void> {
    await this.github.unlinkRepository(projectId, repositoryId, user, meta);
  }

  /** Queues an incremental sync; the response returns before it runs. */
  @Post('projects/:projectId/repositories/:repositoryId/sync')
  @HttpCode(HttpStatus.ACCEPTED)
  @RequireProjectPermission('github:sync')
  @RateLimit({ name: 'github-sync', limit: 10, windowSeconds: 60, by: 'user' })
  requestSync(
    @Param('projectId') projectId: string,
    @Param('repositoryId', new ParseUUIDPipe()) repositoryId: string,
  ): Promise<SyncRequested> {
    return this.github.requestSync(projectId, repositoryId);
  }

  @Get('projects/:projectId/pull-requests')
  @RequireProjectPermission('project:read')
  pullRequests(
    @Param('projectId') projectId: string,
    @ZodQuery(ListPullRequestsQuery) query: ListPullRequestsQuery,
  ): Promise<CursorPage<PullRequest>> {
    return this.github.listPullRequests(projectId, query);
  }

  @Get('projects/:projectId/commits')
  @RequireProjectPermission('project:read')
  commits(
    @Param('projectId') projectId: string,
    @ZodQuery(ListCommitsQuery) query: ListCommitsQuery,
  ): Promise<CursorPage<Commit>> {
    return this.github.listCommits(projectId, query);
  }

  @Get('projects/:projectId/github-issues')
  @RequireProjectPermission('project:read')
  issues(
    @Param('projectId') projectId: string,
    @ZodQuery(ListGithubIssuesQuery) query: ListGithubIssuesQuery,
  ): Promise<CursorPage<GithubIssue>> {
    return this.github.listIssues(projectId, query);
  }

  @Get('issues/:issueId/development')
  @RequireProjectPermission('project:read', 'issue')
  development(@Param('issueId') issueId: string): Promise<IssueDevelopment> {
    return this.github.development(issueId);
  }
}
