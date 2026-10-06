import type { AiJobNotificationPayload } from '@forge/types';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { DelayedError, type Job, UnrecoverableError } from 'bullmq';

import type { AiJob, NotificationType } from '../generated/prisma/client';
import { GithubApiError, GithubRateLimitError } from '../github/github.errors';
import { PrismaService } from '../infrastructure/database/prisma.service';
import { QUEUES } from '../infrastructure/queue/queue.module';
import { AiUsageService } from './ai-usage.service';
import { AiClient } from './ai.client';
import { AiFailedError, AiUnavailableException } from './ai.errors';
import { AI_JOBS, type SummaryJob } from './ai.service';
import { PullRequestReviewer } from './pr-reviewer';
import { loadThread } from './thread';
import { Instrumented } from '../observability/instrumented';

/** Thrown for a job that cannot succeed (its subject was deleted): fail now, do not retry. */
class Gone extends Error {}

/**
 * Runs AI jobs in the worker (architecture §5.3): issue summaries (FR-7.2) and pull request
 * reviews (FR-9). The job row is the user-visible status; BullMQ retries provider outages with
 * backoff, a GitHub rate limit delays the job until the limit resets (without using a retry),
 * and the requester is notified when the result is ready or has finally failed.
 */
@Instrumented(QUEUES.AI)
@Processor(QUEUES.AI, { concurrency: 2 })
export class AiJobProcessor extends WorkerHost {
  private readonly logger = new Logger(AiJobProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly client: AiClient,
    private readonly usage: AiUsageService,
    private readonly reviewer: PullRequestReviewer,
  ) {
    super();
  }

  async process(job: Job, token?: string): Promise<string> {
    if (job.name !== AI_JOBS.ISSUE_SUMMARY && job.name !== AI_JOBS.PR_REVIEW) {
      throw new Error(`Unknown AI job: ${job.name}`);
    }
    const { aiJobId } = job.data as SummaryJob;
    const row = await this.prisma.aiJob.findUnique({ where: { id: aiJobId } });
    if (!row || row.status === 'COMPLETED' || row.status === 'FAILED') return 'skipped';
    await this.prisma.aiJob.update({
      where: { id: aiJobId },
      data: { status: 'RUNNING', startedAt: new Date(), attempts: { increment: 1 } },
    });

    try {
      const result =
        job.name === AI_JOBS.PR_REVIEW ? await this.review(row) : await this.summarize(row);
      await this.finish(aiJobId, 'COMPLETED', null, result);
      await this.notify('AI_JOB_COMPLETED', row);
      return Object.values(result)[0] ?? 'done';
    } catch (error) {
      if (error instanceof GithubRateLimitError && token) {
        await this.prisma.aiJob.update({ where: { id: aiJobId }, data: { status: 'QUEUED' } });
        await job.moveToDelayed(error.resetAt.getTime() + 1000, token);
        throw new DelayedError();
      }
      const what = row.type === 'PR_REVIEW' ? 'review' : 'summary';
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof Gone) {
        await this.finish(aiJobId, 'FAILED', error.message);
        await this.notify('AI_JOB_FAILED', row);
        throw new UnrecoverableError(message);
      }
      const retryable =
        error instanceof AiUnavailableException ||
        (error instanceof AiFailedError && error.retryable) ||
        // GitHub 5xx and network errors may pass; 403/404 (access withdrawn) will not.
        (error instanceof GithubApiError && error.status >= 500);
      const lastAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
      if (retryable && !lastAttempt) {
        await this.prisma.aiJob.update({
          where: { id: aiJobId },
          data: { status: 'QUEUED', error: message.slice(0, 500) },
        });
        throw error;
      }
      this.logger.warn(`AI ${what} job ${aiJobId} failed: ${message}`);
      await this.finish(aiJobId, 'FAILED', `The ${what} could not be made. Please try again.`);
      await this.notify('AI_JOB_FAILED', row);
      throw new UnrecoverableError(message);
    }
  }

  private async summarize(row: AiJob): Promise<{ summaryId: string }> {
    const input = row.input as { issueId: string };
    const thread = await loadThread(this.prisma, input.issueId);
    if (!thread) throw new Gone('The issue was deleted');

    // Another job (or a retry) may already have summarised this exact thread.
    let summary = await this.prisma.aiSummary.findUnique({
      where: { issueId_threadHash: { issueId: input.issueId, threadHash: thread.hash } },
    });
    if (!summary) {
      const started = Date.now();
      const response = await this.client.summarize(thread.input);
      await this.usage.record({
        feature: 'ISSUE_SUMMARY',
        userId: row.requestedById,
        projectId: row.projectId,
        model: response.model,
        promptVersion: response.promptVersion,
        usage: response.usage,
        latencyMs: Date.now() - started,
        success: true,
      });
      summary = await this.prisma.aiSummary.upsert({
        where: { issueId_threadHash: { issueId: input.issueId, threadHash: thread.hash } },
        create: {
          issueId: input.issueId,
          threadHash: thread.hash,
          content: response.summary,
          model: response.model,
          promptVersion: response.promptVersion,
        },
        update: {},
      });
    }
    return { summaryId: summary.id };
  }

  private async review(row: AiJob): Promise<{ reviewId: string }> {
    const outcome = await this.reviewer.run(row);
    if (outcome.kind === 'gone') throw new Gone(outcome.reason);
    return { reviewId: outcome.reviewId };
  }

  private finish(
    id: string,
    status: 'COMPLETED' | 'FAILED',
    error: string | null,
    result?: Record<string, string>,
  ) {
    return this.prisma.aiJob.update({
      where: { id },
      data: { status, error, finishedAt: new Date(), ...(result ? { result } : {}) },
    });
  }

  /** Written once per job and type, however often the job is retried or redelivered. */
  private async notify(type: NotificationType, row: AiJob): Promise<void> {
    if (row.type === 'PR_REVIEW') {
      await this.reviewer.notify(type, row);
      return;
    }
    const thread = await loadThread(this.prisma, (row.input as { issueId: string }).issueId);
    if (!thread) return;
    const payload: AiJobNotificationPayload = {
      projectKey: thread.projectKey,
      issueKey: thread.issueKey,
      issueTitle: thread.issueTitle,
      jobId: row.id,
    };
    await this.prisma.notification.createMany({
      data: [{ userId: row.requestedById, type, payload, dedupeKey: `ai-job:${row.id}:${type}` }],
      skipDuplicates: true,
    });
  }
}
