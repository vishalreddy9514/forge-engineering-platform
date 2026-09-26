import { Module } from '@nestjs/common';

import { configModule, loggerModule } from './config/root-modules';
import { QueueModule } from './infrastructure/queue/queue.module';
import { MailWorkerModule } from './mail/mail.module';

/** Background job processors (architecture §5). Separate process: no HTTP server. */
@Module({
  imports: [
    configModule(),
    loggerModule('worker'),
    QueueModule.forRoot('worker'),
    MailWorkerModule,
  ],
})
export class WorkerModule {}
