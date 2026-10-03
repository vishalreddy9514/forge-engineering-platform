import {
  MissingTest,
  type PullRequestReview,
  ReviewedFile,
  ReviewFinding,
  type ReviewRequested,
  SkippedFile,
} from '@forge/types';
import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, NotFoundException } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { z } from 'zod';

import { AuditService } from '../audit/audit.service';
import type { AuthUser } from '../auth/auth.types';
import type { RequestMeta } from '../common/http/request-meta';
import type { AiReview } from '../generated/prisma/client';
import { GithubSettings } from '../github/github.settings';
import { PrismaService } from '../infrastructure/database/prisma.service';
import { QUEUES } from '../infrastructure/queue/queue.module';
import { AiUsageService } from './ai-usage.service';
import { AiClient } from './ai.client';
import { AiUnavailableException } from './ai.errors';
import { AI_JOBS, toJob } from './ai.service';
import { traced } from '../observability/request-context';

export interface ReviewJob {
  aiJobId: string;
}

/** What an AI_JOB row of type PR_REVIEW was asked to do. */
export const ReviewJobInput = z.object({ pullRequestId: z.uuid(), headSha: z.string() });

/**
 * FR-9 on the API side: requesting a review, and reading the stored one. A review is keyed by
 * the pull request's head commit, so the same code is never reviewed twice, and a review of an
 * older commit is shown as stale once new commits arrive.
 */
@Injectable()
export class PullRequestReviews {
  constructor(
    private readonly prisma: PrismaService,
    private readonly client: AiClient,
    private readonly usage: AiUsageService,
    private readonly github: GithubSettings,
    private readonly audit: AuditService,
    @InjectQueue(QUEUES.AI) private readonly queue: Queue,
  ) {}

  async request(
    projectId: string,
    pullRequestId: string,
    user: AuthUser,
    meta: RequestMeta,
  ): Promise<ReviewRequested> {
    if (!this.client.configured) throw new AiUnavailableException();
    // The diff comes from GitHub: without the App there is nothing to review.
    this.github.require();
    const pr = await this.find(projectId, pullRequestId);

    const cached = await this.prisma.aiReview.findUnique({
      where: { pullRequestId_headSha: { pullRequestId, headSha: pr.headSha } },
    });
    if (cached) return { status: 'completed', review: toReview(cached, pr.headSha) };

    await this.usage.assertWithinBudget(user.id);
    if (!(await this.client.isAvailable({ fresh: true }))) throw new AiUnavailableException();

    const pending = await this.prisma.aiJob.findFirst({
      where: {
        type: 'PR_REVIEW',
        status: { in: ['QUEUED', 'RUNNING'] },
        AND: [
          { input: { path: ['pullRequestId'], equals: pullRequestId } },
          { input: { path: ['headSha'], equals: pr.headSha } },
        ],
      },
      orderBy: { createdAt: 'desc' },
    });
    const job =
      pending ??
      (await this.prisma.aiJob.create({
        data: {
          type: 'PR_REVIEW',
          requestedById: user.id,
          projectId,
          input: { pullRequestId, headSha: pr.headSha },
        },
      }));
    if (!pending) {
      const data: ReviewJob = { aiJobId: job.id };
      await this.queue.add(AI_JOBS.PR_REVIEW, traced(data), {
        jobId: `ai-job-${job.id}`,
        attempts: 3,
        backoff: { type: 'exponential', delay: 15_000 },
        removeOnComplete: { count: 200 },
        removeOnFail: { count: 500 },
      });
      // FR-13: AI review requests are part of the audit trail.
      await this.audit.record(
        {
          action: 'ai.review.requested',
          actorId: user.id,
          entityType: 'pull_request',
          entityId: pullRequestId,
          metadata: { projectId, headSha: pr.headSha, jobId: job.id },
        },
        meta,
      );
    }
    return { status: 'queued', job: toJob(job), statusUrl: `/api/v1/ai/jobs/${job.id}` };
  }

  /** The newest review of the pull request, marked stale if it has moved on since. */
  async latest(projectId: string, pullRequestId: string): Promise<PullRequestReview> {
    const pr = await this.find(projectId, pullRequestId);
    const review = await this.prisma.aiReview.findFirst({
      where: { pullRequestId },
      orderBy: { createdAt: 'desc' },
    });
    if (!review) throw new NotFoundException('No review yet');
    return toReview(review, pr.headSha);
  }

  private async find(projectId: string, pullRequestId: string) {
    const pr = await this.prisma.githubPullRequest.findFirst({
      where: { id: pullRequestId, repository: { projects: { some: { projectId } } } },
      select: { id: true, headSha: true },
    });
    if (!pr) throw new NotFoundException('Pull request not found');
    return pr;
  }
}

export function toReview(row: AiReview, currentHeadSha: string): PullRequestReview {
  return {
    id: row.id,
    headSha: row.headSha,
    summary: row.summary,
    findings: z.array(ReviewFinding).parse(row.findings),
    missingTests: z.array(MissingTest).parse(row.missingTests),
    files: z.array(ReviewedFile).parse(row.files),
    skippedFiles: z.array(SkippedFile).parse(row.skippedFiles),
    model: row.model,
    promptVersion: row.promptVersion,
    createdAt: row.createdAt.toISOString(),
    stale: row.headSha !== currentHeadSha,
  };
}
