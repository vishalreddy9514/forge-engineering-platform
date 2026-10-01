import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';

import { AdminGuard } from '../admin/admin.guard';
import { AiUsageService } from '../ai/ai-usage.service';
import { AiClient } from '../ai/ai.client';
import { QUEUES } from '../infrastructure/queue/queue.module';
import { ChatService } from './chat.service';
import { DocumentsService } from './documents.service';
import { IndexingJobs } from './indexing.jobs';
import { IndexingProcessor } from './indexing.processor';
import { IndexingService } from './indexing.service';
import { DocumentsController, SearchAdminController, SearchController } from './search.controller';
import { SearchService } from './search.service';

/** The indexing queue's producer, for modules that change searchable data (GitHub sync). */
@Module({
  imports: [BullModule.registerQueue({ name: QUEUES.INDEXING })],
  providers: [IndexingJobs],
  exports: [BullModule, IndexingJobs],
})
export class SearchCoreModule {}

/** HTTP side: semantic search, related issues, chat, documents. */
@Module({
  imports: [SearchCoreModule],
  controllers: [SearchController, DocumentsController, SearchAdminController],
  providers: [AiClient, AiUsageService, SearchService, ChatService, DocumentsService, AdminGuard],
})
export class SearchModule {}

/** Worker side: indexing jobs and the periodic backfill. */
@Module({
  imports: [SearchCoreModule],
  providers: [AiClient, AiUsageService, IndexingService, IndexingProcessor],
})
export class SearchWorkerModule {}
