import type { DocumentSourceType } from '@forge/types';
import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import type { JobsOptions, Queue } from 'bullmq';

import { QUEUES } from '../infrastructure/queue/queue.module';

export const INDEXING_JOBS = {
  /** From the outbox: an issue, comment or upload changed (payload: IndexSourceJob). */
  OUTBOX: 'search.index',
  SOURCE: 'index.source',
  /** Every pull request and commit of a repository, for each project it is linked to. */
  REPOSITORY: 'index.repository',
  /** Finds sources that were never indexed (or not since a failure) and queues them. */
  BACKFILL: 'index.backfill',
} as const;

export interface IndexSourceJob {
  sourceType: DocumentSourceType;
  /** The source row's ID; for uploads, the document's own ID. */
  sourceId: string;
  /** Re-embed even when the content hash is unchanged (after an embedding model change). */
  force?: boolean;
}

export interface IndexRepositoryJob {
  repositoryId: string;
  force?: boolean;
}

export interface BackfillJob {
  /** Queue every source, not only unindexed ones (admin "rebuild the index"). */
  all?: boolean;
}

const OPTIONS: JobsOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 5_000 },
  removeOnComplete: { age: 24 * 60 * 60, count: 5_000 },
  removeOnFail: { age: 7 * 24 * 60 * 60 },
};

/**
 * Producer for the indexing queue. Jobs for the same source or repository collapse (see
 * EVENT_DEDUPLICATION): one waiting and at most one running, because a job always indexes the
 * current state.
 */
@Injectable()
export class IndexingJobs {
  constructor(@InjectQueue(QUEUES.INDEXING) private readonly queue: Queue) {}

  async sources(jobs: IndexSourceJob[]): Promise<void> {
    for (let start = 0; start < jobs.length; start += 500) {
      await this.queue.addBulk(
        jobs.slice(start, start + 500).map((data) => ({
          name: INDEXING_JOBS.SOURCE,
          data,
          opts: {
            ...OPTIONS,
            deduplication: {
              id: `index:${data.sourceType}:${data.sourceId}`,
              keepLastIfActive: true,
            },
          },
        })),
      );
    }
  }

  async repository(repositoryId: string, force = false): Promise<void> {
    const data: IndexRepositoryJob = { repositoryId, force };
    await this.queue.add(INDEXING_JOBS.REPOSITORY, data, {
      ...OPTIONS,
      deduplication: { id: `index:repository:${repositoryId}`, keepLastIfActive: true },
    });
  }

  async backfill(all = false): Promise<void> {
    const data: BackfillJob = { all };
    await this.queue.add(INDEXING_JOBS.BACKFILL, data, {
      ...OPTIONS,
      deduplication: { id: `index:backfill:${String(all)}`, keepLastIfActive: true },
    });
  }
}
