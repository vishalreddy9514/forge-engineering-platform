import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';

import { AttachmentsWorkerModule } from '../attachments/attachments.module';
import { QUEUES } from '../infrastructure/queue/queue.module';
import { OutboxRelayModule } from '../outbox/outbox.module';
import { MaintenanceProcessor } from './maintenance.processor';

@Module({
  imports: [
    BullModule.registerQueue({ name: QUEUES.MAINTENANCE }),
    AttachmentsWorkerModule,
    OutboxRelayModule,
  ],
  providers: [MaintenanceProcessor],
})
export class MaintenanceModule {}
