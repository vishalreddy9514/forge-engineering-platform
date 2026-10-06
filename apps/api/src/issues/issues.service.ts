import {
  canTransition,
  type CreateIssueRequest,
  type CursorPage,
  type IssueDetail,
  type IssueEvent,
  type IssuePriority,
  IssuePriority as IssuePriorityEnum,
  type IssueSummary,
  type ListIssuesQuery,
  STATUS_LABELS,
  type UpdateIssueRequest,
} from '@forge/types';
import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';

import type { AuthUser } from '../auth/auth.types';
import { decodeCursorParts, encodeCursorParts } from '../common/http/cursor';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../infrastructure/database/prisma.service';
import { indexLater, writeOutbox } from '../outbox/outbox.writer';
import { allocateIssueNumber } from './issue-number.allocator';
import { diffIssue, type Person } from './issue-changes';
import {
  EVENT_INCLUDE,
  ISSUE_DETAIL_INCLUDE,
  ISSUE_SUMMARY_INCLUDE,
  toIssueDetail,
  toIssueEvent,
  toIssueSummary,
} from './issue.mappers';

const fieldError = (path: string, message: string) =>
  new BadRequestException({ message: 'Validation failed', errors: [{ path, message }] });

/** Enum order in Postgres = declaration order, so `priority asc` puts CRITICAL first. */
const PRIORITY_ORDER = IssuePriorityEnum.options;
const SEARCH_LIMIT = 1000;

/** The list orders (orderBy below) in SQL, for the capped keyword-search prefetch. */
const SEARCH_ORDER: Record<ListIssuesQuery['sort'], Prisma.Sql> = {
  updated: Prisma.sql`updated_at DESC, id DESC`,
  priority: Prisma.sql`priority ASC, updated_at DESC, id DESC`,
  created: Prisma.sql`number DESC`,
};

@Injectable()
export class IssuesService {
  constructor(private readonly prisma: PrismaService) {}

  async get(issueId: string): Promise<IssueDetail> {
    const [issue, commentCount] = await Promise.all([
      this.prisma.issue.findUniqueOrThrow({
        where: { id: issueId },
        include: ISSUE_DETAIL_INCLUDE,
      }),
      this.countComments(issueId),
    ]);
    return toIssueDetail(issue, commentCount);
  }

  async getByKey(projectId: string, number: number): Promise<IssueDetail> {
    const issue = await this.prisma.issue.findUniqueOrThrow({
      where: { projectId_number: { projectId, number } },
      include: ISSUE_DETAIL_INCLUDE,
    });
    return toIssueDetail(issue, await this.countComments(issue.id));
  }

  /** Visible comments on one issue (an index range on issue_comments). */
  private countComments(issueId: string): Promise<number> {
    return this.prisma.issueComment.count({ where: { issueId, deletedAt: null } });
  }

  /** Visible comments per issue, for the issues of one page only. */
  private async commentCounts(issueIds: string[]): Promise<Map<string, number>> {
    if (issueIds.length === 0) return new Map();
    const rows = await this.prisma.issueComment.groupBy({
      by: ['issueId'],
      where: { issueId: { in: issueIds }, deletedAt: null },
      _count: { _all: true },
    });
    return new Map(rows.map((row) => [row.issueId, row._count._all]));
  }

  async create(projectId: string, input: CreateIssueRequest, user: AuthUser): Promise<IssueDetail> {
    const project = await this.prisma.project.findUniqueOrThrow({
      where: { id: projectId },
      select: { defaultAssigneeId: true },
    });

    let assigneeId: string | null;
    if (input.assigneeId === undefined) {
      // Fall back to the project's default assignee, if they are still a member.
      assigneeId = project.defaultAssigneeId;
      if (assigneeId && !(await this.isMember(projectId, assigneeId))) assigneeId = null;
    } else {
      assigneeId = input.assigneeId;
      if (assigneeId) await this.assertMember(projectId, assigneeId);
    }
    await this.assertLabels(projectId, input.labelIds);

    const issue = await this.prisma.$transaction(async (tx) => {
      const number = await allocateIssueNumber(tx, projectId);
      const created = await tx.issue.create({
        data: {
          projectId,
          number,
          title: input.title,
          description: input.description ?? null,
          type: input.type,
          priority: input.priority,
          status: input.status,
          reporterId: user.id,
          assigneeId,
          storyPoints: input.storyPoints ?? null,
          dueDate: input.dueDate ? new Date(input.dueDate) : null,
        },
      });
      if (input.labelIds.length > 0) {
        await tx.issueLabel.createMany({
          data: input.labelIds.map((labelId) => ({ issueId: created.id, labelId, projectId })),
        });
      }
      await tx.issueEvent.create({
        data: {
          issueId: created.id,
          actorId: user.id,
          type: 'CREATED',
          newValue: { title: created.title, status: created.status },
        },
      });
      await indexLater(tx, 'ISSUE', created.id);
      if (assigneeId) {
        await writeOutbox(
          tx,
          'issue.assigned',
          { type: 'issue', id: created.id },
          {
            issueId: created.id,
            assigneeId,
            actorId: user.id,
          },
        );
      }
      return created;
    });
    return this.get(issue.id);
  }

  /**
   * Applies a partial update if the client saw the latest version (FR-4.8). Two people editing
   * the same issue cannot silently overwrite each other: the second save gets 409 and reloads.
   */
  async update(issueId: string, input: UpdateIssueRequest, user: AuthUser): Promise<IssueDetail> {
    const { version, ...fields } = input;

    await this.prisma.$transaction(async (tx) => {
      const before = await tx.issue.findUniqueOrThrow({
        where: { id: issueId },
        include: {
          assignee: { select: { id: true, displayName: true } },
          labels: { select: { label: { select: { id: true, name: true } } } },
        },
      });
      if (before.version !== version) throw this.staleVersion(before.version);

      if (fields.status && !canTransition(before.status, fields.status)) {
        throw fieldError(
          'status',
          `An issue can't move from ${STATUS_LABELS[before.status]} to ${STATUS_LABELS[fields.status]}`,
        );
      }

      let newAssignee: Person | null = null;
      if (fields.assigneeId) {
        const member = await this.assertMember(before.projectId, fields.assigneeId);
        newAssignee = { id: member.id, name: member.displayName };
      }
      const labelNames = fields.labelIds
        ? await this.assertLabels(before.projectId, fields.labelIds)
        : new Map<string, string>();

      const changes = diffIssue({ ...before, labels: before.labels.map((l) => l.label) }, fields, {
        assignees: {
          before: before.assignee
            ? { id: before.assignee.id, name: before.assignee.displayName }
            : null,
          after: newAssignee,
        },
        labelNames,
        now: new Date(),
      });
      if (changes.events.length === 0) return; // nothing changed: no version bump, no history

      // The version predicate closes the race between the read above and this write.
      const updated = await tx.issue.updateMany({
        where: { id: issueId, version },
        data: { ...changes.data, version: { increment: 1 }, updatedAt: new Date() },
      });
      if (updated.count === 0) throw this.staleVersion();

      if (changes.labels.remove.length > 0) {
        await tx.issueLabel.deleteMany({
          where: { issueId, labelId: { in: changes.labels.remove } },
        });
      }
      if (changes.labels.add.length > 0) {
        await tx.issueLabel.createMany({
          data: changes.labels.add.map((labelId) => ({
            issueId,
            labelId,
            projectId: before.projectId,
          })),
        });
      }
      await tx.issueEvent.createMany({
        data: changes.events.map((event) => ({
          issueId,
          actorId: user.id,
          type: event.type,
          field: event.field,
          oldValue: event.oldValue ?? Prisma.JsonNull,
          newValue: event.newValue ?? Prisma.JsonNull,
        })),
      });
      await indexLater(tx, 'ISSUE', issueId);
      if (newAssignee && changes.data.assigneeId !== undefined) {
        await writeOutbox(
          tx,
          'issue.assigned',
          { type: 'issue', id: issueId },
          {
            issueId,
            assigneeId: newAssignee.id,
            actorId: user.id,
          },
        );
      }
    });
    return this.get(issueId);
  }

  /** Soft delete: history, links and comments stay; the issue disappears from every view. */
  async delete(issueId: string, user: AuthUser): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.issue.update({ where: { id: issueId }, data: { deletedAt: new Date() } });
      await tx.issueEvent.create({ data: { issueId, actorId: user.id, type: 'DELETED' } });
      // Removes it, and its comments, from search and the assistant's sources.
      await indexLater(tx, 'ISSUE', issueId);
    });
  }

  async events(issueId: string): Promise<IssueEvent[]> {
    const events = await this.prisma.issueEvent.findMany({
      where: { issueId },
      include: EVENT_INCLUDE,
      orderBy: { id: 'asc' },
      take: 500,
    });
    return events.map(toIssueEvent);
  }

  async list(
    projectId: string,
    query: ListIssuesQuery,
    user: AuthUser,
  ): Promise<CursorPage<IssueSummary>> {
    const filters: Prisma.IssueWhereInput[] = [{ projectId, deletedAt: null }];
    if (query.status) filters.push({ status: { in: query.status } });
    if (query.priority) filters.push({ priority: { in: query.priority } });
    if (query.type) filters.push({ type: { in: query.type } });
    if (query.assignee) {
      filters.push({
        assigneeId:
          query.assignee === 'me' ? user.id : query.assignee === 'none' ? null : query.assignee,
      });
    }
    if (query.label) filters.push({ labels: { some: { labelId: query.label } } });
    if (query.sprint === 'none') {
      filters.push({ sprintIssues: { none: { removedAt: null } } });
    } else if (query.sprint === 'active') {
      filters.push({ sprintIssues: { some: { removedAt: null, sprint: { status: 'ACTIVE' } } } });
    } else if (query.sprint) {
      filters.push({ sprintIssues: { some: { removedAt: null, sprintId: query.sprint } } });
    }
    if (query.q) filters.push({ id: { in: await this.search(projectId, query.q, query.sort) } });

    const cursor = query.cursor ? this.cursorFilter(query.sort, query.cursor) : undefined;
    if (cursor) filters.push(cursor);

    const rows = await this.prisma.issue.findMany({
      where: { AND: filters },
      include: ISSUE_SUMMARY_INCLUDE,
      orderBy: this.orderBy(query.sort),
      take: query.limit + 1,
    });
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    const comments = await this.commentCounts(page.map((issue) => issue.id));
    return {
      data: page.map((issue) => toIssueSummary(issue, comments.get(issue.id) ?? 0)),
      nextCursor: rows.length > query.limit && last ? this.encodeCursor(query.sort, last) : null,
    };
  }

  /**
   * Keyword search (FR-11.1): the generated full-text column (stemmed, so "resetting" finds
   * "reset"), plus a substring match on the title for partial words and issue-key fragments.
   */
  private async search(
    projectId: string,
    q: string,
    sort: ListIssuesQuery['sort'],
  ): Promise<string[]> {
    const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    // The matches are capped, so take them in the list's own order: the cap then drops the end
    // of the list, never an arbitrary part of it (with 6k matches it used to drop the newest).
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT id FROM issues
      WHERE project_id = ${projectId}::uuid AND deleted_at IS NULL
        AND (search_vector @@ websearch_to_tsquery('english', ${q}) OR title ILIKE ${like})
      ORDER BY ${SEARCH_ORDER[sort]}
      LIMIT ${SEARCH_LIMIT}`;
    return rows.map((row) => row.id);
  }

  private orderBy(sort: ListIssuesQuery['sort']): Prisma.IssueOrderByWithRelationInput[] {
    switch (sort) {
      case 'created':
        return [{ number: 'desc' }];
      case 'priority':
        return [{ priority: 'asc' }, { updatedAt: 'desc' }, { id: 'desc' }];
      case 'updated':
        return [{ updatedAt: 'desc' }, { id: 'desc' }];
    }
  }

  private encodeCursor(
    sort: ListIssuesQuery['sort'],
    issue: { number: number; priority: IssuePriority; updatedAt: Date; id: string },
  ): string {
    switch (sort) {
      case 'created':
        return encodeCursorParts(String(issue.number));
      case 'priority':
        return encodeCursorParts(issue.priority, issue.updatedAt.toISOString(), issue.id);
      case 'updated':
        return encodeCursorParts(issue.updatedAt.toISOString(), issue.id);
    }
  }

  /** Keyset condition: rows strictly after the cursor in the chosen sort order. */
  private cursorFilter(sort: ListIssuesQuery['sort'], cursor: string): Prisma.IssueWhereInput {
    const afterUpdated = (updatedAt: Date, id: string): Prisma.IssueWhereInput => ({
      OR: [{ updatedAt: { lt: updatedAt } }, { updatedAt, id: { lt: id } }],
    });
    switch (sort) {
      case 'created': {
        const [number = ''] = decodeCursorParts(cursor, 1);
        return { number: { lt: Number(number) } };
      }
      case 'updated': {
        const [iso = '', id = ''] = decodeCursorParts(cursor, 2);
        return afterUpdated(new Date(iso), id);
      }
      case 'priority': {
        const [priority = '', iso = '', id = ''] = decodeCursorParts(cursor, 3);
        const index = PRIORITY_ORDER.indexOf(priority as IssuePriority);
        if (index === -1) throw new BadRequestException('Invalid cursor');
        return {
          OR: [
            { priority: { in: PRIORITY_ORDER.slice(index + 1) } },
            { AND: [{ priority: priority as IssuePriority }, afterUpdated(new Date(iso), id)] },
          ],
        };
      }
    }
  }

  private async isMember(projectId: string, userId: string): Promise<boolean> {
    return (await this.prisma.projectMember.count({ where: { projectId, userId } })) > 0;
  }

  private async assertMember(projectId: string, userId: string) {
    const member = await this.prisma.projectMember.findUnique({
      where: { projectId_userId: { projectId, userId } },
      select: { user: { select: { id: true, displayName: true } } },
    });
    if (!member) throw fieldError('assigneeId', 'The assignee must be a member of this project');
    return member.user;
  }

  /** Labels must belong to this project; returns id → name for history entries. */
  private async assertLabels(projectId: string, labelIds: string[]): Promise<Map<string, string>> {
    if (labelIds.length === 0) return new Map();
    const labels = await this.prisma.label.findMany({
      where: { projectId, id: { in: labelIds } },
      select: { id: true, name: true },
    });
    if (labels.length !== labelIds.length) {
      throw fieldError('labelIds', 'One or more labels do not belong to this project');
    }
    return new Map(labels.map((l) => [l.id, l.name]));
  }

  private staleVersion(currentVersion?: number) {
    return new ConflictException({
      message: 'This issue was changed by someone else. Reload it and try again.',
      ...(currentVersion
        ? { errors: [{ path: 'version', message: `Current version is ${currentVersion}` }] }
        : {}),
    });
  }
}
