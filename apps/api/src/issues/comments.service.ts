import type { Comment } from '@forge/types';
import { ForbiddenException, Injectable } from '@nestjs/common';

import type { ProjectAccess } from '../access-control/project-access.guard';
import { can } from '../access-control/permissions';
import type { AuthUser } from '../auth/auth.types';
import { PrismaService } from '../infrastructure/database/prisma.service';
import { COMMENT_INCLUDE, toComment } from './issue.mappers';

@Injectable()
export class CommentsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(issueId: string): Promise<Comment[]> {
    const comments = await this.prisma.issueComment.findMany({
      where: { issueId },
      include: COMMENT_INCLUDE,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return comments.map(toComment);
  }

  async create(issueId: string, body: string, user: AuthUser): Promise<Comment> {
    const comment = await this.prisma.$transaction(async (tx) => {
      const created = await tx.issueComment.create({
        data: { issueId, authorId: user.id, body },
        include: COMMENT_INCLUDE,
      });
      await tx.issueEvent.create({
        data: {
          issueId,
          actorId: user.id,
          type: 'COMMENT_ADDED',
          newValue: { commentId: created.id },
        },
      });
      // Activity counts as an update for "recently updated" ordering (not a version change).
      await tx.issue.update({ where: { id: issueId }, data: { updatedAt: new Date() } });
      return created;
    });
    return toComment(comment);
  }

  async update(
    commentId: string,
    body: string,
    user: AuthUser,
    access: ProjectAccess,
  ): Promise<Comment> {
    const existing = await this.assertCanChange(commentId, user, access);
    const comment = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.issueComment.update({
        where: { id: commentId },
        data: { body, editedAt: new Date() },
        include: COMMENT_INCLUDE,
      });
      await tx.issueEvent.create({
        data: {
          issueId: existing.issueId,
          actorId: user.id,
          type: 'COMMENT_EDITED',
          newValue: { commentId },
        },
      });
      return updated;
    });
    return toComment(comment);
  }

  /** Soft delete: the thread shows "comment deleted" in its place. */
  async delete(commentId: string, user: AuthUser, access: ProjectAccess): Promise<void> {
    const existing = await this.assertCanChange(commentId, user, access);
    await this.prisma.$transaction([
      this.prisma.issueComment.update({
        where: { id: commentId },
        data: { deletedAt: new Date() },
      }),
      this.prisma.issueEvent.create({
        data: {
          issueId: existing.issueId,
          actorId: user.id,
          type: 'COMMENT_DELETED',
          oldValue: { commentId },
        },
      }),
    ]);
  }

  /** Authors change their own comments; managers (comment:moderate) change anyone's. */
  private async assertCanChange(commentId: string, user: AuthUser, access: ProjectAccess) {
    const comment = await this.prisma.issueComment.findUniqueOrThrow({
      where: { id: commentId },
      select: { authorId: true, issueId: true },
    });
    if (comment.authorId !== user.id && !can(access.role, 'comment:moderate')) {
      throw new ForbiddenException('You can only change your own comments');
    }
    return comment;
  }
}
