import {
  type Attachment,
  type AttachmentUpload,
  CreateAttachmentRequest,
  type DownloadUrl,
} from '@forge/types';
import { Controller, Delete, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import type { ProjectAccess } from '../access-control/project-access.guard';
import { CurrentProjectAccess } from '../access-control/project-access.decorator';
import { RequireProjectPermission } from '../access-control/require-project-permission.decorator';
import type { AuthUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators';
import { ApiZodBody, ZodBody } from '../common/http/zod';
import { AttachmentsService } from './attachments.service';

@ApiTags('attachments')
@ApiBearerAuth()
@Controller()
export class AttachmentsController {
  constructor(private readonly attachments: AttachmentsService) {}

  @Get('issues/:issueId/attachments')
  @RequireProjectPermission('project:read', 'issue')
  list(@Param('issueId') issueId: string): Promise<Attachment[]> {
    return this.attachments.list(issueId);
  }

  @Post('issues/:issueId/attachments')
  @RequireProjectPermission('attachment:create', 'issue')
  @ApiZodBody(CreateAttachmentRequest)
  requestUpload(
    @Param('issueId') issueId: string,
    @ZodBody(CreateAttachmentRequest) body: CreateAttachmentRequest,
    @CurrentUser() user: AuthUser,
  ): Promise<AttachmentUpload> {
    return this.attachments.requestUpload(issueId, body, user);
  }

  @Post('attachments/:attachmentId/complete')
  @HttpCode(HttpStatus.OK)
  @RequireProjectPermission('attachment:create', 'attachment')
  complete(
    @Param('attachmentId') attachmentId: string,
    @CurrentUser() user: AuthUser,
  ): Promise<Attachment> {
    return this.attachments.complete(attachmentId, user);
  }

  @Get('attachments/:attachmentId/download')
  @RequireProjectPermission('project:read', 'attachment')
  download(@Param('attachmentId') attachmentId: string): Promise<DownloadUrl> {
    return this.attachments.downloadUrl(attachmentId);
  }

  @Delete('attachments/:attachmentId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireProjectPermission('attachment:create', 'attachment')
  async delete(
    @Param('attachmentId') attachmentId: string,
    @CurrentUser() user: AuthUser,
    @CurrentProjectAccess() access: ProjectAccess,
  ): Promise<void> {
    await this.attachments.delete(attachmentId, user, access);
  }
}
