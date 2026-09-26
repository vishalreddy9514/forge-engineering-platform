import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';

import { QUEUES } from '../infrastructure/queue/queue.module';
import { EmailProcessor } from './email.processor';
import { EmailProducer } from './email.producer';
import { MailerService } from './mailer.service';

/** API side: enqueue only. */
@Module({
  imports: [BullModule.registerQueue({ name: QUEUES.EMAIL })],
  providers: [EmailProducer],
  exports: [EmailProducer],
})
export class MailModule {}

/** Worker side: consume and deliver. */
@Module({
  imports: [BullModule.registerQueue({ name: QUEUES.EMAIL })],
  providers: [EmailProcessor, MailerService],
})
export class MailWorkerModule {}
