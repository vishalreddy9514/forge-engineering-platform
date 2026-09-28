import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';

import { QUEUES } from '../infrastructure/queue/queue.module';
import { GithubSync } from './github-sync.service';
import { GithubWebhookController } from './github-webhook.controller';
import { GithubWebhookHandler } from './github-webhook.handler';
import { GithubClient } from './github.client';
import { GithubController } from './github.controller';
import { GithubJobs } from './github.jobs';
import { GithubProcessor } from './github.processor';
import { GithubService } from './github.service';
import { GithubSettings } from './github.settings';
import { IssueLinker } from './issue-linker';

/** Shared by the API and the worker: configuration, the REST client, sync and the job producer. */
@Module({
  imports: [BullModule.registerQueue({ name: QUEUES.GITHUB })],
  providers: [GithubSettings, GithubClient, GithubJobs, IssueLinker, GithubSync],
  // The queue too: the worker's processor injects it to register its job schedulers.
  exports: [BullModule, GithubSettings, GithubClient, GithubJobs, IssueLinker, GithubSync],
})
export class GithubCoreModule {}

/** HTTP side: the REST endpoints and the webhook receiver. */
@Module({
  imports: [GithubCoreModule],
  controllers: [GithubController, GithubWebhookController],
  providers: [GithubService],
})
export class GithubModule {}

/** Worker side: sync jobs, webhook processing and reconciliation. */
@Module({
  imports: [GithubCoreModule],
  providers: [GithubWebhookHandler, GithubProcessor],
})
export class GithubWorkerModule {}
