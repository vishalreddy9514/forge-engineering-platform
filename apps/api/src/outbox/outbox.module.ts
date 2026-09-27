import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';

import { QUEUES } from '../infrastructure/queue/queue.module';
import { OutboxRelay } from './outbox.relay';

/** Worker side: publishes outbox rows to the queues. The API only writes rows (outbox.writer). */
@Module({
  imports: [BullModule.registerQueue({ name: QUEUES.NOTIFICATIONS })],
  providers: [OutboxRelay],
  exports: [OutboxRelay],
})
export class OutboxRelayModule {}
