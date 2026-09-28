import type { IssueNotificationPayload, NotificationPayload } from '@forge/types';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { Env } from '../config/env';
import type { NotificationType } from '../generated/prisma/client';
import { PrismaService } from '../infrastructure/database/prisma.service';
import { EmailProducer } from '../mail/email.producer';
import type { OutboxJob } from '../outbox/outbox.events';

interface Recipient {
  id: string;
  email: string;
  displayName: string;
}

/**
 * Turns domain events into notifications (FR-12). Runs in the worker. Every handler reloads
 * current state and is idempotent: the same outbox event processed twice creates nothing new,
 * and an event that no longer applies (issue deleted, reassigned again) is skipped.
 */
@Injectable()
export class NotificationFanout {
  private readonly logger = new Logger(NotificationFanout.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailProducer,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async issueAssigned(event: OutboxJob<'issue.assigned'>): Promise<number> {
    const issue = await this.loadIssue(event.issueId);
    // Stale: deleted since, or reassigned again (that assignment has its own event).
    if (!issue || issue.assigneeId !== event.assigneeId) return 0;
    if (event.assigneeId === event.actorId) return 0; // assigning yourself needs no notice

    const [recipient] = await this.eligible(issue.projectId, [event.assigneeId]);
    if (!recipient) return 0;
    const actorName = await this.actorName(event.actorId);
    const payload = this.payload(issue, actorName);

    const created = await this.create('ISSUE_ASSIGNED', [recipient], payload, event.outboxId);
    if (created > 0) {
      // Email only when the in-app notification is new, so a redelivered event sends none.
      await this.email.sendIssueAssigned(
        {
          to: recipient.email,
          displayName: recipient.displayName,
          actorName,
          issueKey: payload.issueKey,
          issueTitle: payload.issueTitle,
          issueUrl: `${this.config.get('WEB_ORIGIN', { infer: true })}/projects/${payload.projectKey}/issues/${payload.issueKey}`,
        },
        `assigned-${event.outboxId}`,
      );
    }
    return created;
  }

  /** Notifies the people involved: reporter, assignee and earlier commenters. */
  async commentAdded(event: OutboxJob<'comment.added'>): Promise<number> {
    const issue = await this.loadIssue(event.issueId);
    if (!issue) return 0;
    const comment = await this.prisma.issueComment.findUnique({
      where: { id: event.commentId },
      select: { deletedAt: true },
    });
    if (!comment || comment.deletedAt) return 0;

    const commenters = await this.prisma.issueComment.findMany({
      where: { issueId: issue.id, deletedAt: null },
      select: { authorId: true },
      distinct: ['authorId'],
    });
    const involved = new Set([
      issue.reporterId,
      ...(issue.assigneeId ? [issue.assigneeId] : []),
      ...commenters.map((c) => c.authorId),
    ]);
    involved.delete(event.actorId);

    const recipients = await this.eligible(issue.projectId, [...involved]);
    if (recipients.length === 0) return 0;
    const payload = this.payload(issue, await this.actorName(event.actorId));
    return this.create('COMMENT_ADDED', recipients, payload, event.outboxId);
  }

  /** Everyone on the project hears when a sprint starts or ends, except whoever did it. */
  async sprintChanged(
    type: 'SPRINT_STARTED' | 'SPRINT_COMPLETED',
    event: OutboxJob<'sprint.started'>,
  ): Promise<number> {
    const sprint = await this.prisma.sprint.findUnique({
      where: { id: event.sprintId },
      select: {
        name: true,
        status: true,
        projectId: true,
        project: { select: { key: true, members: { select: { userId: true } } } },
      },
    });
    // Stale: deleted, or no longer in the state this event announces.
    const expected = type === 'SPRINT_STARTED' ? ['ACTIVE', 'COMPLETED'] : ['COMPLETED'];
    if (!sprint || !expected.includes(sprint.status)) return 0;

    const others = sprint.project.members.map((m) => m.userId).filter((id) => id !== event.actorId);
    const recipients = await this.eligible(sprint.projectId, others);
    if (recipients.length === 0) return 0;
    return this.create(
      type,
      recipients,
      {
        projectKey: sprint.project.key,
        sprintId: event.sprintId,
        sprintName: sprint.name,
        actorName: await this.actorName(event.actorId),
      },
      event.outboxId,
    );
  }

  private loadIssue(issueId: string) {
    return this.prisma.issue.findFirst({
      where: { id: issueId, deletedAt: null },
      select: {
        id: true,
        number: true,
        title: true,
        projectId: true,
        reporterId: true,
        assigneeId: true,
        project: { select: { key: true } },
      },
    });
  }

  /** Only active users who can still see the project are notified. */
  private async eligible(projectId: string, userIds: string[]): Promise<Recipient[]> {
    if (userIds.length === 0) return [];
    return this.prisma.user.findMany({
      where: {
        id: { in: userIds },
        isActive: true,
        memberships: { some: { projectId } },
      },
      select: { id: true, email: true, displayName: true },
    });
  }

  private async actorName(actorId: string): Promise<string> {
    const actor = await this.prisma.user.findUnique({
      where: { id: actorId },
      select: { displayName: true },
    });
    return actor?.displayName ?? 'Someone';
  }

  private payload(
    issue: { number: number; title: string; project: { key: string } },
    actorName: string,
  ): IssueNotificationPayload {
    return {
      projectKey: issue.project.key,
      issueKey: `${issue.project.key}-${String(issue.number)}`,
      issueTitle: issue.title,
      actorName,
    };
  }

  /** Inserts one row per recipient; rows that already exist for this event are skipped. */
  private async create(
    type: NotificationType,
    recipients: Recipient[],
    payload: NotificationPayload,
    outboxId: string,
  ): Promise<number> {
    const { count } = await this.prisma.notification.createMany({
      data: recipients.map((r) => ({
        userId: r.id,
        type,
        payload,
        dedupeKey: `outbox:${outboxId}`,
      })),
      skipDuplicates: true,
    });
    this.logger.log({ type, outboxId, recipients: recipients.length, created: count }, 'Notified');
    return count;
  }
}
