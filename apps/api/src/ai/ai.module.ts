import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';

import { QUEUES } from '../infrastructure/queue/queue.module';
import { AiDraftsService } from './ai-drafts.service';
import { AiJobProcessor } from './ai-jobs.processor';
import { AiUsageService } from './ai-usage.service';
import { AiClient } from './ai.client';
import { AiController } from './ai.controller';
import { AiService } from './ai.service';
import { PullRequestReviewer } from './pr-reviewer';
import { PullRequestReviews } from './pr-reviews.service';
import { GithubCoreModule } from '../github/github.module';

@Module({
  imports: [BullModule.registerQueue({ name: QUEUES.AI }), GithubCoreModule],
  controllers: [AiController],
  providers: [AiClient, AiUsageService, AiService, AiDraftsService, PullRequestReviews],
})
export class AiModule {}

/** Worker side: summary and review jobs. */
@Module({
  imports: [BullModule.registerQueue({ name: QUEUES.AI }), GithubCoreModule],
  providers: [AiClient, AiUsageService, PullRequestReviewer, AiJobProcessor],
})
export class AiWorkerModule {}
