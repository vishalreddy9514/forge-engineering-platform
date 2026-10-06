import type { AiJob, AiStatus, IssueAiSummary, SummaryRequested } from '@forge/types';
import { ThreadSummary } from '@forge/types';
import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, NotFoundException } from '@nestjs/common';
import type { Queue } from 'bullmq';

import type { AuthUser } from '../auth/auth.types';
import type { AiJob as AiJobRow, AiSummary } from '../generated/prisma/client';
import { PrismaService } from '../infrastructure/database/prisma.service';
import { QUEUES } from '../infrastructure/queue/queue.module';
import { AiUsageService } from './ai-usage.service';
import { AiClient } from './ai.client';
import { AiUnavailableException } from './ai.errors';
import { loadThread } from './thread';
import { traced } from '../observability/request-context';

export const AI_JOBS = { ISSUE_SUMMARY: 'issue.summary', PR_REVIEW: 'pr.review' } as const;

export interface SummaryJob {
  aiJobId: string;
}

@Injectable()
export class AiService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly client: AiClient,
    private readonly usage: AiUsageService,
    @InjectQueue(QUEUES.AI) private readonly queue: Queue,
  ) {}

  async status(userId: string): Promise<AiStatus> {
    const [available, budget] = await Promise.all([
      this.client.isAvailable(),
      this.usage.budget(userId),
    ]);
    return { available, budget };
  }

  /**
   * FR-7.2. A summary of the thread as it is now is returned at once when one exists; otherwise
   * one job is queued per thread version (asking twice returns the same job).
   */
  async requestSummary(issueId: string, user: AuthUser): Promise<SummaryRequested> {
    if (!this.client.configured) throw new AiUnavailableException();
    const thread = await loadThread(this.prisma, issueId);
    if (!thread) throw new NotFoundException('Issue not found');

    const cached = await this.prisma.aiSummary.findUnique({
      where: { issueId_threadHash: { issueId, threadHash: thread.hash } },
    });
    if (cached) return { status: 'completed', summary: toSummary(cached, false) };

    await this.usage.assertWithinBudget(user.id);
    // Say so now rather than queue a job that can only fail minutes later (NFR-4).
    if (!(await this.client.isAvailable({ fresh: true }))) throw new AiUnavailableException();
    const pending = await this.prisma.aiJob.findFirst({
      where: {
        type: 'ISSUE_SUMMARY',
        status: { in: ['QUEUED', 'RUNNING'] },
        AND: [
          { input: { path: ['issueId'], equals: issueId } },
          { input: { path: ['threadHash'], equals: thread.hash } },
        ],
      },
      orderBy: { createdAt: 'desc' },
    });
    const job =
      pending ??
      (await this.prisma.aiJob.create({
        data: {
          type: 'ISSUE_SUMMARY',
          requestedById: user.id,
          projectId: thread.projectId,
          input: { issueId, threadHash: thread.hash },
        },
      }));
    if (!pending) {
      const data: SummaryJob = { aiJobId: job.id };
      await this.queue.add(AI_JOBS.ISSUE_SUMMARY, traced(data), {
        jobId: `ai-job-${job.id}`,
        attempts: 3,
        backoff: { type: 'exponential', delay: 10_000 },
        removeOnComplete: { count: 200 },
        removeOnFail: { count: 500 },
      });
    }
    return { status: 'queued', job: toJob(job), statusUrl: `/api/v1/ai/jobs/${job.id}` };
  }

  /** The newest summary of the issue, marked stale if the thread has changed since. */
  async latestSummary(issueId: string): Promise<IssueAiSummary> {
    const [thread, latest] = await Promise.all([
      loadThread(this.prisma, issueId),
      this.prisma.aiSummary.findFirst({ where: { issueId }, orderBy: { createdAt: 'desc' } }),
    ]);
    if (!thread || !latest) throw new NotFoundException('No summary yet');
    return toSummary(latest, latest.threadHash !== thread.hash);
  }

  /** Jobs are visible to whoever started them (and administrators); others get a 404. */
  async job(jobId: string, user: AuthUser): Promise<AiJob> {
    const job = await this.prisma.aiJob.findUnique({ where: { id: jobId } });
    if (!job || (job.requestedById !== user.id && !user.isAdmin)) {
      throw new NotFoundException('Job not found');
    }
    return toJob(job);
  }
}

export function toSummary(row: AiSummary, stale: boolean): IssueAiSummary {
  return {
    summary: ThreadSummary.parse(row.content),
    generatedAt: row.createdAt.toISOString(),
    model: row.model,
    promptVersion: row.promptVersion,
    stale,
  };
}

export function toJob(row: AiJobRow): AiJob {
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    error: row.error,
    createdAt: row.createdAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
  };
}
