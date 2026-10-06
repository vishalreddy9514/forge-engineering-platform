import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger, type OnApplicationBootstrap } from '@nestjs/common';
import type { Job, Queue } from 'bullmq';

import { QUEUES } from '../infrastructure/queue/queue.module';
import {
  type BackfillJob,
  INDEXING_JOBS,
  type IndexRepositoryJob,
  type IndexSourceJob,
} from './indexing.jobs';
import { IndexingService } from './indexing.service';
import { Instrumented } from '../observability/instrumented';

const HOUR = 60 * 60 * 1000;

/**
 * Runs indexing in the worker (FR-8.2). Concurrency is modest: each job may call the embedding
 * API, and keeping a few in flight is enough to keep up with edits without bursting the
 * provider's rate limit. Failures retry with backoff (the AI service being down is the common
 * case); whatever still fails is picked up by the periodic backfill.
 */
@Instrumented(QUEUES.INDEXING)
@Processor(QUEUES.INDEXING, { concurrency: 3 })
export class IndexingProcessor extends WorkerHost implements OnApplicationBootstrap {
  private readonly logger = new Logger(IndexingProcessor.name);

  constructor(
    @InjectQueue(QUEUES.INDEXING) private readonly queue: Queue,
    private readonly indexing: IndexingService,
  ) {
    super();
  }

  async onApplicationBootstrap(): Promise<void> {
    // Runs once at startup (upsert schedules the first run now), then every six hours.
    await this.queue.upsertJobScheduler(
      INDEXING_JOBS.BACKFILL,
      { every: 6 * HOUR },
      {
        name: INDEXING_JOBS.BACKFILL,
        data: { all: false } satisfies BackfillJob,
        opts: { removeOnComplete: { count: 20 }, removeOnFail: { count: 20 } },
      },
    );
  }

  async process(job: Job): Promise<unknown> {
    switch (job.name) {
      case INDEXING_JOBS.OUTBOX:
      case INDEXING_JOBS.SOURCE:
        return this.indexing.indexSource(job.data as IndexSourceJob);
      case INDEXING_JOBS.REPOSITORY: {
        const { repositoryId, force } = job.data as IndexRepositoryJob;
        return this.indexing.indexRepository(repositoryId, force);
      }
      case INDEXING_JOBS.BACKFILL:
        return this.indexing.backfill((job.data as BackfillJob).all ?? false);
      default:
        this.logger.warn({ name: job.name }, 'Unknown indexing job');
        throw new Error(`Unknown indexing job: ${job.name}`);
    }
  }
}
