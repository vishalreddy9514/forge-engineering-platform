import { Module } from '@nestjs/common';

import { AttachmentCleanup } from './attachment-cleanup.service';
import { AttachmentsController } from './attachments.controller';
import { AttachmentsService } from './attachments.service';

@Module({
  controllers: [AttachmentsController],
  providers: [AttachmentsService],
})
export class AttachmentsModule {}

/** Worker side: the abandoned-upload cleanup. */
@Module({
  providers: [AttachmentCleanup],
  exports: [AttachmentCleanup],
})
export class AttachmentsWorkerModule {}
