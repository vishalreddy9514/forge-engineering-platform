import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import type { JobsOptions, Queue } from 'bullmq';

import { QUEUES } from '../infrastructure/queue/queue.module';

export const GITHUB_JOBS = {
  SYNC_INSTALLATION: 'installation.sync',
  SYNC_REPOSITORY: 'repository.sync',
  PROCESS_WEBHOOK: 'webhook.process',
  RECONCILE: 'reconcile',
  PRUNE_DELIVERIES: 'deliveries.prune',
} as const;

export interface SyncInstallationJob {
  installationId: number;
}
export interface SyncRepositoryJob {
  repositoryId: string;
  relink?: boolean;
}
export interface ProcessWebhookJob {
  deliveryId: string;
}

const RETRIES: JobsOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 30_000 },
  removeOnComplete: { count: 200 },
  removeOnFail: { count: 500 },
};

/**
 * Enqueues GitHub work. Sync jobs are deduplicated while one is waiting, so a burst of requests
 * (a user clicking "Sync" repeatedly, reconciliation overlapping a webhook) queues one sync.
 */
@Injectable()
export class GithubJobs {
  constructor(@InjectQueue(QUEUES.GITHUB) private readonly queue: Queue) {}

  async syncInstallation(installationId: number): Promise<void> {
    const data: SyncInstallationJob = { installationId };
    await this.queue.add(GITHUB_JOBS.SYNC_INSTALLATION, data, {
      ...RETRIES,
      deduplication: { id: `installation-sync-${String(installationId)}` },
    });
  }

  async syncRepository(repositoryId: string, options: { relink?: boolean } = {}): Promise<void> {
    const data: SyncRepositoryJob = { repositoryId, relink: options.relink ?? false };
    await this.queue.add(GITHUB_JOBS.SYNC_REPOSITORY, data, {
      ...RETRIES,
      deduplication: { id: `repository-sync-${repositoryId}${options.relink ? '-relink' : ''}` },
    });
  }

  /** One job per delivery: the delivery ID is the job ID, so a redelivery never queues twice. */
  async processWebhook(deliveryId: string): Promise<void> {
    const data: ProcessWebhookJob = { deliveryId };
    await this.queue.add(GITHUB_JOBS.PROCESS_WEBHOOK, data, {
      ...RETRIES,
      jobId: `delivery-${deliveryId}`,
    });
  }
}
