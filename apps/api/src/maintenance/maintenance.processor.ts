import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { type OnApplicationBootstrap } from '@nestjs/common';
import type { Job, Queue } from 'bullmq';

import { AttachmentCleanup } from '../attachments/attachment-cleanup.service';
import { QUEUES } from '../infrastructure/queue/queue.module';
import { OutboxRelay } from '../outbox/outbox.relay';

export const MAINTENANCE_JOBS = {
  CLEANUP_UPLOADS: 'attachments.cleanup',
  PRUNE_OUTBOX: 'outbox.prune',
} as const;

const HOUR = 60 * 60 * 1000;

/**
 * Periodic housekeeping. Job schedulers live in Redis and are upserted by ID, so every worker
 * replica can register them at startup without creating duplicates.
 */
@Processor(QUEUES.MAINTENANCE, { concurrency: 1 })
export class MaintenanceProcessor extends WorkerHost implements OnApplicationBootstrap {
  constructor(
    @InjectQueue(QUEUES.MAINTENANCE) private readonly queue: Queue,
    private readonly uploads: AttachmentCleanup,
    private readonly outbox: OutboxRelay,
  ) {
    super();
  }

  async onApplicationBootstrap(): Promise<void> {
    const options = { removeOnComplete: { count: 50 }, removeOnFail: { count: 50 } };
    await this.queue.upsertJobScheduler(
      MAINTENANCE_JOBS.CLEANUP_UPLOADS,
      { every: HOUR },
      { name: MAINTENANCE_JOBS.CLEANUP_UPLOADS, opts: options },
    );
    await this.queue.upsertJobScheduler(
      MAINTENANCE_JOBS.PRUNE_OUTBOX,
      { every: 24 * HOUR },
      { name: MAINTENANCE_JOBS.PRUNE_OUTBOX, opts: options },
    );
  }

  async process(job: Job): Promise<number> {
    switch (job.name) {
      case MAINTENANCE_JOBS.CLEANUP_UPLOADS:
        return this.uploads.removeAbandonedUploads();
      case MAINTENANCE_JOBS.PRUNE_OUTBOX:
        return this.outbox.prune();
      default:
        throw new Error(`Unknown maintenance job: ${job.name}`);
    }
  }
}
