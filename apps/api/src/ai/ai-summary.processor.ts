import type { AiJobNotificationPayload } from '@forge/types';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { type Job, UnrecoverableError } from 'bullmq';

import type { NotificationType } from '../generated/prisma/client';
import { PrismaService } from '../infrastructure/database/prisma.service';
import { QUEUES } from '../infrastructure/queue/queue.module';
import { AiUsageService } from './ai-usage.service';
import { AiClient } from './ai.client';
import { AiFailedError, AiUnavailableException } from './ai.errors';
import { AI_JOBS, type SummaryJob } from './ai.service';
import { loadThread } from './thread';

/**
 * Makes thread summaries in the worker (FR-7.2, async per architecture §5.3). The job row is
 * the user-visible status; BullMQ retries provider outages with backoff, and the requester is
 * notified when the summary is ready or has finally failed.
 */
@Processor(QUEUES.AI, { concurrency: 2 })
export class AiSummaryProcessor extends WorkerHost {
  private readonly logger = new Logger(AiSummaryProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly client: AiClient,
    private readonly usage: AiUsageService,
  ) {
    super();
  }

  async process(job: Job): Promise<string> {
    if (job.name !== AI_JOBS.ISSUE_SUMMARY) throw new Error(`Unknown AI job: ${job.name}`);
    const { aiJobId } = job.data as SummaryJob;
    const row = await this.prisma.aiJob.findUnique({ where: { id: aiJobId } });
    if (!row || row.status === 'COMPLETED' || row.status === 'FAILED') return 'skipped';

    const input = row.input as { issueId: string };
    await this.prisma.aiJob.update({
      where: { id: aiJobId },
      data: { status: 'RUNNING', startedAt: new Date(), attempts: { increment: 1 } },
    });

    const thread = await loadThread(this.prisma, input.issueId);
    if (!thread) {
      await this.finish(aiJobId, 'FAILED', 'The issue was deleted');
      return 'issue deleted';
    }

    try {
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
      await this.finish(aiJobId, 'COMPLETED', null, { summaryId: summary.id });
      await this.notify('AI_JOB_COMPLETED', row.requestedById, aiJobId, thread);
      return summary.id;
    } catch (error) {
      const retryable =
        error instanceof AiUnavailableException ||
        (error instanceof AiFailedError && error.retryable);
      const lastAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
      const message = error instanceof Error ? error.message : String(error);
      if (retryable && !lastAttempt) {
        await this.prisma.aiJob.update({
          where: { id: aiJobId },
          data: { status: 'QUEUED', error: message.slice(0, 500) },
        });
        throw error;
      }
      this.logger.warn(`Summary job ${aiJobId} failed: ${message}`);
      await this.finish(aiJobId, 'FAILED', 'The summary could not be made. Please try again.');
      await this.notify('AI_JOB_FAILED', row.requestedById, aiJobId, thread);
      throw new UnrecoverableError(message);
    }
  }

  private finish(
    id: string,
    status: 'COMPLETED' | 'FAILED',
    error: string | null,
    result?: { summaryId: string },
  ) {
    return this.prisma.aiJob.update({
      where: { id },
      data: { status, error, finishedAt: new Date(), ...(result ? { result } : {}) },
    });
  }

  /** Written once per job and type, however often the job is retried or redelivered. */
  private async notify(
    type: NotificationType,
    userId: string,
    jobId: string,
    thread: { projectKey: string; issueKey: string; issueTitle: string },
  ): Promise<void> {
    const payload: AiJobNotificationPayload = {
      projectKey: thread.projectKey,
      issueKey: thread.issueKey,
      issueTitle: thread.issueTitle,
      jobId,
    };
    await this.prisma.notification.createMany({
      data: [{ userId, type, payload, dedupeKey: `ai-job:${jobId}:${type}` }],
      skipDuplicates: true,
    });
  }
}
