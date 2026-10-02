import type { AiJobNotificationPayload } from '@forge/types';
import { Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';

import type { AiJob, NotificationType } from '../generated/prisma/client';
import { GithubClient } from '../github/github.client';
import { PrismaService } from '../infrastructure/database/prisma.service';
import { AiUsageService } from './ai-usage.service';
import { AiClient } from './ai.client';
import type { ReviewResponse } from './ai.wire';
import { ReviewJobInput } from './pr-reviews.service';
import { type GithubPullFile, selectReviewFiles } from './review-files';

/** GitHub lists at most 3,000 files per pull request, 100 per page. */
const MAX_FILE_PAGES = 30;

const PullFile = z.object({
  filename: z.string(),
  status: z.string(),
  additions: z.number().int(),
  deletions: z.number().int(),
  patch: z.string().optional(),
});
const PullHead = z.object({ head: z.object({ sha: z.string() }) });

export type ReviewOutcome =
  { kind: 'reviewed'; reviewId: string; headSha: string } | { kind: 'gone'; reason: string };

/**
 * Runs one PR review job in the worker (FR-9.1–9.3): reads the pull request's current head and
 * changed files from GitHub, chooses what to send, asks the AI service for the review, stores it
 * keyed by head commit and records its cost. GitHub and AI errors propagate, so the processor
 * can retry, delay for a rate limit, or fail the job for good.
 */
@Injectable()
export class PullRequestReviewer {
  private readonly logger = new Logger(PullRequestReviewer.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly github: GithubClient,
    private readonly client: AiClient,
    private readonly usage: AiUsageService,
  ) {}

  async run(job: AiJob): Promise<ReviewOutcome> {
    const input = ReviewJobInput.parse(job.input);
    const pr = await this.prisma.githubPullRequest.findUnique({
      where: { id: input.pullRequestId },
      select: {
        id: true,
        number: true,
        title: true,
        body: true,
        repository: {
          select: {
            fullName: true,
            installation: { select: { installationId: true } },
          },
        },
      },
    });
    if (!pr) return { kind: 'gone', reason: 'The pull request is no longer available' };

    const installationId = Number(pr.repository.installation.installationId);
    const base = `/repos/${pr.repository.fullName}/pulls/${String(pr.number)}`;
    // Review what the pull request contains now, which may be newer than when it was requested.
    const head = PullHead.parse(
      await this.github.get(installationId, base, {}, { background: true }),
    );
    const headSha = head.head.sha;

    const existing = await this.prisma.aiReview.findUnique({
      where: { pullRequestId_headSha: { pullRequestId: pr.id, headSha } },
      select: { id: true },
    });
    if (existing) return { kind: 'reviewed', reviewId: existing.id, headSha };

    const files: GithubPullFile[] = [];
    for await (const page of this.github.paginate(
      installationId,
      `${base}/files`,
      {},
      {
        maxPages: MAX_FILE_PAGES,
        background: true,
      },
    )) {
      files.push(...z.array(PullFile).parse(page));
    }
    const selection = selectReviewFiles(files);

    let response: ReviewResponse;
    if (selection.files.length === 0) {
      // Nothing reviewable (only lockfiles, generated or binary files): say so, at no cost.
      response = {
        summary: 'Nothing to review: every changed file was skipped (see the list below).',
        findings: [],
        missingTests: [],
        files: [],
        model: 'none',
        promptVersion: 'pr_review@1',
        calls: 0,
        usage: { inputTokens: 0, outputTokens: 0, costUsd: '0' },
      };
    } else {
      const started = Date.now();
      response = await this.client.review({
        pullRequest: {
          number: pr.number,
          title: pr.title,
          body: pr.body,
          repository: pr.repository.fullName,
        },
        files: selection.files,
        omittedFiles: selection.omitted,
      });
      await this.usage.record({
        feature: 'PR_REVIEW',
        userId: job.requestedById,
        projectId: job.projectId,
        model: response.model,
        promptVersion: response.promptVersion,
        usage: response.usage,
        latencyMs: Date.now() - started,
        success: true,
      });
    }

    const review = await this.prisma.aiReview.upsert({
      where: { pullRequestId_headSha: { pullRequestId: pr.id, headSha } },
      create: {
        pullRequestId: pr.id,
        headSha,
        summary: response.summary,
        findings: response.findings,
        missingTests: response.missingTests,
        files: response.files,
        skippedFiles: selection.omitted,
        model: response.model.slice(0, 100),
        promptVersion: response.promptVersion.slice(0, 50),
      },
      update: {},
      select: { id: true },
    });
    // The stored head moves to what GitHub says, so the page knows whether the review is current.
    await this.prisma.githubPullRequest.updateMany({
      where: { id: pr.id, headSha: { not: headSha } },
      data: { headSha },
    });
    this.logger.log(
      { pullRequestId: pr.id, files: selection.files.length, skipped: selection.omitted.length },
      'Pull request reviewed',
    );
    return { kind: 'reviewed', reviewId: review.id, headSha };
  }

  /** Written once per job and type, however often the job is retried or redelivered. */
  async notify(type: NotificationType, job: AiJob): Promise<void> {
    const input = ReviewJobInput.safeParse(job.input);
    if (!input.success) return;
    const pr = await this.prisma.githubPullRequest.findUnique({
      where: { id: input.data.pullRequestId },
      select: { number: true, title: true, repository: { select: { fullName: true } } },
    });
    const project = await this.prisma.project.findUnique({
      where: { id: job.projectId },
      select: { key: true },
    });
    if (!pr || !project) return;
    const payload: AiJobNotificationPayload = {
      projectKey: project.key,
      jobId: job.id,
      repository: pr.repository.fullName,
      pullRequestId: input.data.pullRequestId,
      pullRequestNumber: pr.number,
      pullRequestTitle: pr.title,
    };
    await this.prisma.notification.createMany({
      data: [{ userId: job.requestedById, type, payload, dedupeKey: `ai-job:${job.id}:${type}` }],
      skipDuplicates: true,
    });
  }
}
