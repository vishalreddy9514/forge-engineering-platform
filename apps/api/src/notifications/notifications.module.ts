import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';

import { QUEUES } from '../infrastructure/queue/queue.module';
import { MailModule } from '../mail/mail.module';
import { NotificationFanout } from './notification-fanout.service';

import { NotificationsController } from './notifications.controller';
import { NotificationsProcessor } from './notifications.processor';
import { NotificationsService } from './notifications.service';

/** API side: read and mark notifications. They are created by the worker (outbox → queue). */
@Module({
  controllers: [NotificationsController],
  providers: [NotificationsService],
})
export class NotificationsModule {}

/** Worker side: create notifications (and assignment emails) from relayed domain events. */
@Module({
  imports: [BullModule.registerQueue({ name: QUEUES.NOTIFICATIONS }), MailModule],
  providers: [NotificationsProcessor, NotificationFanout],
  exports: [NotificationFanout],
})
export class NotificationsWorkerModule {}
