import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';

import { QUEUES } from '../infrastructure/queue/queue.module';
import type { OutboxJob } from '../outbox/outbox.events';
import { NotificationFanout } from './notification-fanout.service';
import { Instrumented } from '../observability/instrumented';

/** Consumes domain events relayed from the outbox. Throws on failure so BullMQ retries. */
@Instrumented(QUEUES.NOTIFICATIONS)
@Processor(QUEUES.NOTIFICATIONS, { concurrency: 10 })
export class NotificationsProcessor extends WorkerHost {
  constructor(private readonly fanout: NotificationFanout) {
    super();
  }

  async process(job: Job): Promise<number> {
    switch (job.name) {
      case 'issue.assigned':
        return this.fanout.issueAssigned(job.data as OutboxJob<'issue.assigned'>);
      case 'comment.added':
        return this.fanout.commentAdded(job.data as OutboxJob<'comment.added'>);
      case 'sprint.started':
        return this.fanout.sprintChanged('SPRINT_STARTED', job.data as OutboxJob<'sprint.started'>);
      case 'sprint.completed':
        return this.fanout.sprintChanged(
          'SPRINT_COMPLETED',
          job.data as OutboxJob<'sprint.completed'>,
        );
      case 'pull_request.opened':
        return this.fanout.pullRequestOpened(job.data as OutboxJob<'pull_request.opened'>);
      default:
        throw new Error(`Unknown notification job: ${job.name}`);
    }
  }
}
