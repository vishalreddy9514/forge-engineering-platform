import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';

import { QUEUES } from '../infrastructure/queue/queue.module';
import { AiDraftsService } from './ai-drafts.service';
import { AiSummaryProcessor } from './ai-summary.processor';
import { AiUsageService } from './ai-usage.service';
import { AiClient } from './ai.client';
import { AiController } from './ai.controller';
import { AiService } from './ai.service';

@Module({
  imports: [BullModule.registerQueue({ name: QUEUES.AI })],
  controllers: [AiController],
  providers: [AiClient, AiUsageService, AiService, AiDraftsService],
})
export class AiModule {}

/** Worker side: summary jobs. */
@Module({
  imports: [BullModule.registerQueue({ name: QUEUES.AI })],
  providers: [AiClient, AiUsageService, AiSummaryProcessor],
})
export class AiWorkerModule {}
