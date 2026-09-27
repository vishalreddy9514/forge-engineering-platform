import { Module } from '@nestjs/common';

import { configModule, loggerModule } from './config/root-modules';
import { GithubWorkerModule } from './github/github.module';
import { DatabaseModule } from './infrastructure/database/database.module';
import { QueueModule } from './infrastructure/queue/queue.module';
import { RedisModule } from './infrastructure/redis/redis.module';
import { StorageModule } from './infrastructure/storage/storage.module';
import { MailWorkerModule } from './mail/mail.module';
import { MaintenanceModule } from './maintenance/maintenance.module';
import { NotificationsWorkerModule } from './notifications/notifications.module';
import { OutboxRelayModule } from './outbox/outbox.module';

/** Background job processors (architecture §5). Separate process: no HTTP server. */
@Module({
  imports: [
    configModule(),
    loggerModule('worker'),
    DatabaseModule,
    RedisModule,
    StorageModule,
    QueueModule.forRoot('worker'),
    MailWorkerModule,
    OutboxRelayModule,
    NotificationsWorkerModule,
    MaintenanceModule,
    GithubWorkerModule,
  ],
})
export class WorkerModule {}
