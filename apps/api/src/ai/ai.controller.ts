import {
  type AiJob,
  type AiStatus,
  DraftRequest,
  type IssueAiSummary,
  type PullRequestReview,
  type ReviewRequested,
  type SummaryRequested,
} from '@forge/types';
import { Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';

import { RequireProjectPermission } from '../access-control/require-project-permission.decorator';
import type { AuthUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators';
import { type RequestMeta, ReqMeta } from '../common/http/request-meta';
import { ApiZodBody, ZodBody } from '../common/http/zod';
import { RateLimit } from '../rate-limit/rate-limit.decorator';
import { AiDraftsService } from './ai-drafts.service';
import { AiService } from './ai.service';
import { PullRequestReviews } from './pr-reviews.service';

/** Architecture §6.5: AI endpoints get their own, tighter limit. */
const AI_RATE_LIMIT = { name: 'ai', limit: 20, windowSeconds: 60, by: 'user' } as const;

@ApiTags('ai')
@ApiBearerAuth()
@Controller()
export class AiController {
  constructor(
    private readonly ai: AiService,
    private readonly drafts: AiDraftsService,
    private readonly reviews: PullRequestReviews,
  ) {}

  @Get('ai/status')
  status(@CurrentUser() user: AuthUser): Promise<AiStatus> {
    return this.ai.status(user.id);
  }

  /** text/event-stream: `delta`* then `result` or `error` (see docs/api.md). */
  @Post('projects/:projectId/ai/drafts')
  @RequireProjectPermission('ai:write')
  @RateLimit(AI_RATE_LIMIT)
  @ApiZodBody(DraftRequest)
  async draft(
    @Param('projectId') projectId: string,
    @ZodBody(DraftRequest) body: DraftRequest,
    @CurrentUser() user: AuthUser,
    @Res() res: Response,
  ): Promise<void> {
    await this.drafts.stream(projectId, user.id, body, res);
  }

  /** 200 with the summary when the thread is unchanged since the last one, else 202 + job. */
  @Post('issues/:issueId/ai/summaries')
  @RequireProjectPermission('ai:write', 'issue')
  @RateLimit(AI_RATE_LIMIT)
  async summarize(
    @Param('issueId') issueId: string,
    @CurrentUser() user: AuthUser,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SummaryRequested> {
    const result = await this.ai.requestSummary(issueId, user);
    res.status(result.status === 'completed' ? 200 : 202);
    return result;
  }

  @Get('issues/:issueId/ai/summary')
  @RequireProjectPermission('project:read', 'issue')
  summary(@Param('issueId') issueId: string): Promise<IssueAiSummary> {
    return this.ai.latestSummary(issueId);
  }

  /** FR-9: 200 with the review if this commit was already reviewed, else 202 + job. */
  @Post('projects/:projectId/pull-requests/:pullRequestId/ai/reviews')
  @RequireProjectPermission('ai:write')
  @RateLimit(AI_RATE_LIMIT)
  async review(
    @Param('projectId') projectId: string,
    @Param('pullRequestId', new ParseUUIDPipe()) pullRequestId: string,
    @CurrentUser() user: AuthUser,
    @ReqMeta() meta: RequestMeta,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ReviewRequested> {
    const result = await this.reviews.request(projectId, pullRequestId, user, meta);
    res.status(result.status === 'completed' ? 200 : 202);
    return result;
  }

  @Get('projects/:projectId/pull-requests/:pullRequestId/ai/review')
  @RequireProjectPermission('project:read')
  latestReview(
    @Param('projectId') projectId: string,
    @Param('pullRequestId', new ParseUUIDPipe()) pullRequestId: string,
  ): Promise<PullRequestReview> {
    return this.reviews.latest(projectId, pullRequestId);
  }

  @Get('ai/jobs/:jobId')
  @HttpCode(200)
  job(
    @Param('jobId', new ParseUUIDPipe()) jobId: string,
    @CurrentUser() user: AuthUser,
  ): Promise<AiJob> {
    return this.ai.job(jobId, user);
  }
}
