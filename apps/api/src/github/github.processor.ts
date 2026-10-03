import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { DelayedError, type Job, type Queue, UnrecoverableError } from 'bullmq';

import { QUEUES } from '../infrastructure/queue/queue.module';
import { PrismaService } from '../infrastructure/database/prisma.service';
import { GithubSync } from './github-sync.service';
import { GithubWebhookHandler } from './github-webhook.handler';
import { GithubApiError, GithubRateLimitError } from './github.errors';
import {
  GITHUB_JOBS,
  GithubJobs,
  type ProcessWebhookJob,
  type SyncInstallationJob,
  type SyncRepositoryJob,
} from './github.jobs';
import { GithubSettings } from './github.settings';
import { Instrumented } from '../observability/instrumented';

const HOUR = 60 * 60 * 1000;
/** Webhook deliveries are kept this long for debugging and replay, then pruned. */
const DELIVERY_RETENTION_DAYS = 14;
/** A stored delivery with no processed job after this long was never queued (Redis was down). */
const STRANDED_DELIVERY_MS = 10 * 60 * 1000;

/**
 * Runs GitHub work in the worker: installation and repository syncs, webhook deliveries, and
 * the hourly reconciliation that catches anything a missed webhook left behind (ADR-0008).
 *
 * Rate limits are not failures: a job that hits one is moved back to the delayed set until the
 * reset time (plus jitter, so jobs for one installation do not all resume in the same second)
 * without using up a retry attempt.
 */
@Instrumented(QUEUES.GITHUB)
@Processor(QUEUES.GITHUB, { concurrency: 4 })
export class GithubProcessor extends WorkerHost implements OnApplicationBootstrap {
  private readonly logger = new Logger(GithubProcessor.name);

  constructor(
    @InjectQueue(QUEUES.GITHUB) private readonly queue: Queue,
    private readonly prisma: PrismaService,
    private readonly settings: GithubSettings,
    private readonly sync: GithubSync,
    private readonly webhooks: GithubWebhookHandler,
    private readonly jobs: GithubJobs,
  ) {
    super();
  }

  async onApplicationBootstrap(): Promise<void> {
    if (!this.settings.app) return; // integration disabled: nothing to reconcile
    const options = { removeOnComplete: { count: 50 }, removeOnFail: { count: 50 } };
    await this.queue.upsertJobScheduler(
      GITHUB_JOBS.RECONCILE,
      { every: HOUR },
      { name: GITHUB_JOBS.RECONCILE, opts: options },
    );
    await this.queue.upsertJobScheduler(
      GITHUB_JOBS.PRUNE_DELIVERIES,
      { every: 24 * HOUR },
      { name: GITHUB_JOBS.PRUNE_DELIVERIES, opts: options },
    );
  }

  async process(job: Job, token?: string): Promise<unknown> {
    try {
      return await this.run(job);
    } catch (error) {
      const repositoryId =
        job.name === GITHUB_JOBS.SYNC_REPOSITORY
          ? (job.data as SyncRepositoryJob).repositoryId
          : undefined;
      if (error instanceof GithubRateLimitError && token) {
        if (repositoryId) await this.sync.setStatus(repositoryId, 'RATE_LIMITED', null);
        const jitter = Math.floor(Math.random() * 30_000);
        await job.moveToDelayed(error.resetAt.getTime() + 1000 + jitter, token);
        throw new DelayedError();
      }
      if (repositoryId) {
        await this.sync.setStatus(
          repositoryId,
          'FAILED',
          error instanceof Error ? error.message : String(error),
        );
      }
      // Not found or forbidden will not change on a retry (uninstalled, access withdrawn); the
      // next sync a person or reconciliation requests tries again.
      if (error instanceof GithubApiError && (error.status === 403 || error.status === 404)) {
        throw new UnrecoverableError(error.message);
      }
      throw error;
    }
  }

  private async run(job: Job): Promise<unknown> {
    switch (job.name) {
      case GITHUB_JOBS.SYNC_INSTALLATION:
        return this.sync.syncInstallation((job.data as SyncInstallationJob).installationId);
      case GITHUB_JOBS.SYNC_REPOSITORY: {
        const { repositoryId, relink } = job.data as SyncRepositoryJob;
        await this.sync.syncRepository(repositoryId, { relink });
        return repositoryId;
      }
      case GITHUB_JOBS.PROCESS_WEBHOOK:
        return this.webhooks.process((job.data as ProcessWebhookJob).deliveryId);
      case GITHUB_JOBS.RECONCILE:
        return this.reconcile();
      case GITHUB_JOBS.PRUNE_DELIVERIES:
        return this.pruneDeliveries();
      default:
        throw new Error(`Unknown GitHub job: ${job.name}`);
    }
  }

  /**
   * Hourly: incremental sync of every linked repository, and re-queueing of deliveries that
   * were stored but never processed. GitHub does not redeliver failed webhooks by itself.
   */
  async reconcile(): Promise<{ repositories: number; deliveries: number }> {
    const repositories = await this.prisma.githubRepository.findMany({
      where: { projects: { some: {} }, installation: { suspendedAt: null } },
      select: { id: true },
    });
    for (const { id } of repositories) await this.jobs.syncRepository(id);

    const stranded = await this.prisma.githubWebhookDelivery.findMany({
      where: {
        processedAt: null,
        error: null,
        receivedAt: { lt: new Date(Date.now() - STRANDED_DELIVERY_MS) },
      },
      select: { id: true },
      take: 1000,
    });
    for (const { id } of stranded) await this.jobs.processWebhook(id);

    this.logger.log(
      { repositories: repositories.length, deliveries: stranded.length },
      'GitHub reconciliation queued',
    );
    return { repositories: repositories.length, deliveries: stranded.length };
  }

  async pruneDeliveries(): Promise<number> {
    const { count } = await this.prisma.githubWebhookDelivery.deleteMany({
      where: { receivedAt: { lt: new Date(Date.now() - DELIVERY_RETENTION_DAYS * 24 * HOUR) } },
    });
    return count;
  }
}
