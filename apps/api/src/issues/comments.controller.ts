import { type Comment, CreateCommentRequest, UpdateCommentRequest } from '@forge/types';
import { Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import type { ProjectAccess } from '../access-control/project-access.guard';
import { CurrentProjectAccess } from '../access-control/project-access.decorator';
import { RequireProjectPermission } from '../access-control/require-project-permission.decorator';
import type { AuthUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators';
import { ApiZodBody, ZodBody } from '../common/http/zod';
import { CommentsService } from './comments.service';

@ApiTags('comments')
@ApiBearerAuth()
@Controller()
export class CommentsController {
  constructor(private readonly comments: CommentsService) {}

  @Get('issues/:issueId/comments')
  @RequireProjectPermission('project:read', 'issue')
  list(@Param('issueId') issueId: string): Promise<Comment[]> {
    return this.comments.list(issueId);
  }

  @Post('issues/:issueId/comments')
  @RequireProjectPermission('comment:create', 'issue')
  @ApiZodBody(CreateCommentRequest)
  create(
    @Param('issueId') issueId: string,
    @ZodBody(CreateCommentRequest) body: CreateCommentRequest,
    @CurrentUser() user: AuthUser,
  ): Promise<Comment> {
    return this.comments.create(issueId, body.body, user);
  }

  @Patch('comments/:commentId')
  @RequireProjectPermission('comment:create', 'comment')
  @ApiZodBody(UpdateCommentRequest)
  update(
    @Param('commentId') commentId: string,
    @ZodBody(UpdateCommentRequest) body: UpdateCommentRequest,
    @CurrentUser() user: AuthUser,
    @CurrentProjectAccess() access: ProjectAccess,
  ): Promise<Comment> {
    return this.comments.update(commentId, body.body, user, access);
  }

  @Delete('comments/:commentId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireProjectPermission('comment:create', 'comment')
  async delete(
    @Param('commentId') commentId: string,
    @CurrentUser() user: AuthUser,
    @CurrentProjectAccess() access: ProjectAccess,
  ): Promise<void> {
    await this.comments.delete(commentId, user, access);
  }
}
