import type { Comment, IssueDetail, IssueEvent, IssueSummary } from '@forge/types';

import type { Prisma } from '../generated/prisma/client';
import { toUserSummary, USER_SUMMARY_SELECT } from '../users/user-summary';

export const ISSUE_SUMMARY_INCLUDE = {
  project: { select: { key: true } },
  assignee: { select: USER_SUMMARY_SELECT },
  labels: { select: { label: { select: { id: true, name: true, color: true } } } },
  _count: { select: { comments: { where: { deletedAt: null } } } },
  // The current sprint membership (at most one, by a partial unique index).
  sprintIssues: {
    where: { removedAt: null },
    select: { sprint: { select: { id: true, name: true } } },
    take: 1,
  },
} as const satisfies Prisma.IssueInclude;

export const ISSUE_DETAIL_INCLUDE = {
  ...ISSUE_SUMMARY_INCLUDE,
  reporter: { select: USER_SUMMARY_SELECT },
} as const satisfies Prisma.IssueInclude;

type SummaryRow = Prisma.IssueGetPayload<{ include: typeof ISSUE_SUMMARY_INCLUDE }>;
type DetailRow = Prisma.IssueGetPayload<{ include: typeof ISSUE_DETAIL_INCLUDE }>;

/** Dates-only column (due date) as YYYY-MM-DD. */
export const toDateOnly = (date: Date | null) => date?.toISOString().slice(0, 10) ?? null;

export function toIssueSummary(issue: SummaryRow): IssueSummary {
  return {
    id: issue.id,
    key: `${issue.project.key}-${issue.number}`,
    number: issue.number,
    title: issue.title,
    type: issue.type,
    status: issue.status,
    priority: issue.priority,
    assignee: issue.assignee ? toUserSummary(issue.assignee) : null,
    labels: issue.labels.map((l) => l.label).sort((a, b) => a.name.localeCompare(b.name)),
    sprint: issue.sprintIssues[0]?.sprint ?? null,
    storyPoints: issue.storyPoints,
    dueDate: toDateOnly(issue.dueDate),
    commentCount: issue._count.comments,
    version: issue.version,
    createdAt: issue.createdAt.toISOString(),
    updatedAt: issue.updatedAt.toISOString(),
  };
}

export function toIssueDetail(issue: DetailRow): IssueDetail {
  return {
    ...toIssueSummary(issue),
    projectId: issue.projectId,
    projectKey: issue.project.key,
    description: issue.description,
    reporter: toUserSummary(issue.reporter),
    resolvedAt: issue.resolvedAt?.toISOString() ?? null,
  };
}

export const COMMENT_INCLUDE = { author: { select: USER_SUMMARY_SELECT } } as const;
type CommentRow = Prisma.IssueCommentGetPayload<{ include: typeof COMMENT_INCLUDE }>;

export function toComment(comment: CommentRow): Comment {
  const deleted = comment.deletedAt !== null;
  return {
    id: comment.id,
    body: deleted ? null : comment.body,
    author: toUserSummary(comment.author),
    createdAt: comment.createdAt.toISOString(),
    editedAt: comment.editedAt?.toISOString() ?? null,
    deleted,
  };
}

export const EVENT_INCLUDE = { actor: { select: USER_SUMMARY_SELECT } } as const;
type EventRow = Prisma.IssueEventGetPayload<{ include: typeof EVENT_INCLUDE }>;

export function toIssueEvent(event: EventRow): IssueEvent {
  return {
    id: event.id.toString(),
    type: event.type,
    field: event.field,
    oldValue: event.oldValue,
    newValue: event.newValue,
    actor: event.actor ? toUserSummary(event.actor) : null,
    createdAt: event.createdAt.toISOString(),
  };
}
