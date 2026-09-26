import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';

import { QUEUES } from '../infrastructure/queue/queue.module';
import { EMAIL_JOBS, type IssueAssignedEmailJob, type PasswordResetEmailJob } from './email.jobs';
import { MailerService } from './mailer.service';
import { renderIssueAssigned, renderPasswordReset } from './templates';

/** Runs in the worker process. Failures throw, so BullMQ retries with backoff. */
@Processor(QUEUES.EMAIL, { concurrency: 5 })
export class EmailProcessor extends WorkerHost {
  private readonly logger = new Logger(EmailProcessor.name);

  constructor(private readonly mailer: MailerService) {
    super();
  }

  async process(job: Job): Promise<void> {
    switch (job.name) {
      case EMAIL_JOBS.PASSWORD_RESET: {
        const data = job.data as PasswordResetEmailJob;
        await this.mailer.send(data.to, renderPasswordReset(data));
        break;
      }
      case EMAIL_JOBS.ISSUE_ASSIGNED: {
        const data = job.data as IssueAssignedEmailJob;
        await this.mailer.send(data.to, renderIssueAssigned(data));
        break;
      }
      default:
        throw new Error(`Unknown email job: ${job.name}`);
    }
    this.logger.log({ jobId: job.id, job: job.name, attempt: job.attemptsMade + 1 }, 'Email sent');
  }
}
