import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import type { JobsOptions, Queue } from 'bullmq';

import { QUEUES } from '../infrastructure/queue/queue.module';
import { EMAIL_JOBS, type IssueAssignedEmailJob, type PasswordResetEmailJob } from './email.jobs';

const JOB_OPTIONS: JobsOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 5_000 },
  // Reset links are credentials: drop the job (and its payload) from Redis once it succeeds.
  removeOnComplete: true,
  removeOnFail: { age: 24 * 60 * 60 },
};

/**
 * Sends email asynchronously (NFR-2). Besides keeping SMTP latency off the request path, this
 * makes the password-reset endpoint take the same time whether or not the account exists.
 */
@Injectable()
export class EmailProducer {
  constructor(@InjectQueue(QUEUES.EMAIL) private readonly queue: Queue) {}

  async sendPasswordReset(job: PasswordResetEmailJob): Promise<void> {
    await this.queue.add(EMAIL_JOBS.PASSWORD_RESET, job, JOB_OPTIONS);
  }

  /** `jobId` makes a repeated request for the same notification collapse into one email. */
  async sendIssueAssigned(job: IssueAssignedEmailJob, jobId: string): Promise<void> {
    await this.queue.add(EMAIL_JOBS.ISSUE_ASSIGNED, job, {
      ...JOB_OPTIONS,
      jobId,
      removeOnComplete: { age: 24 * 60 * 60 },
    });
  }
}
