import { z } from 'zod';

import { IssuePriority, IssueStatus, IssueType } from './enums';
import { CursorPaginationQuery } from './pagination';
import { UserSummary } from './projects';

// ───────────── Workflow ─────────────

/**
 * Allowed status changes (FR-4.3). The normal path is BACKLOG → TODO → IN_PROGRESS →
 * IN_REVIEW → DONE; work can step back, finished work can be reopened, and anything unfinished
 * can be cancelled. The API enforces this table; the web app uses it to offer only valid moves.
 */
export const ISSUE_TRANSITIONS: Record<IssueStatus, readonly IssueStatus[]> = {
  BACKLOG: ['TODO', 'IN_PROGRESS', 'CANCELLED'],
  TODO: ['BACKLOG', 'IN_PROGRESS', 'CANCELLED'],
  IN_PROGRESS: ['TODO', 'IN_REVIEW', 'DONE', 'CANCELLED'],
  IN_REVIEW: ['IN_PROGRESS', 'DONE', 'CANCELLED'],
  DONE: ['TODO', 'IN_PROGRESS'],
  CANCELLED: ['BACKLOG', 'TODO'],
};

export function canTransition(from: IssueStatus, to: IssueStatus): boolean {
  return from === to || ISSUE_TRANSITIONS[from].includes(to);
}

/** DONE and CANCELLED are terminal: they set `resolvedAt`, and leaving them clears it. */
export function isResolved(status: IssueStatus): boolean {
  return status === 'DONE' || status === 'CANCELLED';
}

export const STATUS_LABELS: Record<IssueStatus, string> = {
  BACKLOG: 'Backlog',
  TODO: 'To do',
  IN_PROGRESS: 'In progress',
  IN_REVIEW: 'In review',
  DONE: 'Done',
  CANCELLED: 'Cancelled',
};

export const PRIORITY_LABELS: Record<IssuePriority, string> = {
  CRITICAL: 'Critical',
  HIGH: 'High',
  MEDIUM: 'Medium',
  LOW: 'Low',
};

export const TYPE_LABELS: Record<IssueType, string> = {
  BUG: 'Bug',
  FEATURE: 'Feature',
  TASK: 'Task',
  CHORE: 'Chore',
};

// ───────────── Keys ─────────────

const ISSUE_KEY = /^([A-Za-z][A-Za-z0-9]{1,9})-(\d{1,9})$/;

/** "PAY-123" → { projectKey: "PAY", number: 123 }; null if it is not an issue key. */
export function parseIssueKey(key: string): { projectKey: string; number: number } | null {
  const match = ISSUE_KEY.exec(key.trim());
  if (!match?.[1] || !match[2]) return null;
  const number = Number(match[2]);
  return number > 0 ? { projectKey: match[1].toUpperCase(), number } : null;
}

// ───────────── Requests ─────────────

const Title = z.string().trim().min(1, 'Enter a title').max(200, 'Use at most 200 characters');
const Description = z.string().max(50_000, 'Descriptions are limited to 50,000 characters');
const StoryPoints = z.number().int().min(0).max(100);
const DueDate = z.iso.date({ message: 'Use a date like 2026-10-31' });
const LabelIds = z
  .array(z.uuid())
  .max(20, 'Use at most 20 labels')
  .refine((ids) => new Set(ids).size === ids.length, 'Each label can only be added once');

export const CreateIssueRequest = z.object({
  title: Title,
  description: Description.optional(),
  type: IssueType.default('TASK'),
  priority: IssuePriority.default('MEDIUM'),
  /** New issues start in the backlog or straight in To do. */
  status: z.enum(['BACKLOG', 'TODO']).default('BACKLOG'),
  /** Omitted → the project's default assignee; null → explicitly unassigned. */
  assigneeId: z.uuid().nullable().optional(),
  labelIds: LabelIds.default([]),
  storyPoints: StoryPoints.nullable().optional(),
  dueDate: DueDate.nullable().optional(),
});
export type CreateIssueRequest = z.infer<typeof CreateIssueRequest>;

export const UpdateIssueRequest = z
  .object({
    /** The version the client last saw (optimistic locking, FR-4.8). */
    version: z.number().int().positive(),
    title: Title.optional(),
    description: Description.nullable().optional(),
    type: IssueType.optional(),
    status: IssueStatus.optional(),
    priority: IssuePriority.optional(),
    assigneeId: z.uuid().nullable().optional(),
    /** The complete new set of labels. */
    labelIds: LabelIds.optional(),
    storyPoints: StoryPoints.nullable().optional(),
    dueDate: DueDate.nullable().optional(),
  })
  .refine((body) => Object.keys(body).length > 1, { message: 'Nothing to update' });
export type UpdateIssueRequest = z.infer<typeof UpdateIssueRequest>;

/** "TODO,IN_PROGRESS" → ["TODO", "IN_PROGRESS"] (query-string multi-select). */
const commaSeparated = z.string().transform((value) => value.split(',').filter(Boolean));

export const IssueSort = z.enum(['updated', 'created', 'priority']);
export type IssueSort = z.infer<typeof IssueSort>;

export const ListIssuesQuery = CursorPaginationQuery.extend({
  status: commaSeparated.pipe(z.array(IssueStatus).max(10)).optional(),
  priority: commaSeparated.pipe(z.array(IssuePriority).max(10)).optional(),
  type: commaSeparated.pipe(z.array(IssueType).max(10)).optional(),
  /** A user id, "me", or "none" (unassigned). */
  assignee: z.union([z.uuid(), z.enum(['me', 'none'])]).optional(),
  label: z.uuid().optional(),
  q: z.string().trim().min(1).max(200).optional(),
  sort: IssueSort.default('updated'),
});
export type ListIssuesQuery = z.infer<typeof ListIssuesQuery>;

export const CreateCommentRequest = z.object({
  body: z.string().trim().min(1, 'Write a comment').max(10_000),
});
export type CreateCommentRequest = z.infer<typeof CreateCommentRequest>;
export const UpdateCommentRequest = CreateCommentRequest;
export type UpdateCommentRequest = CreateCommentRequest;

// ───────────── Responses ─────────────

export const LabelChip = z.object({ id: z.uuid(), name: z.string(), color: z.string() });
export type LabelChip = z.infer<typeof LabelChip>;

export const IssueSummary = z.object({
  id: z.uuid(),
  key: z.string(),
  number: z.number().int(),
  title: z.string(),
  type: IssueType,
  status: IssueStatus,
  priority: IssuePriority,
  assignee: UserSummary.nullable(),
  labels: z.array(LabelChip),
  storyPoints: z.number().int().nullable(),
  dueDate: z.string().nullable(),
  commentCount: z.number().int(),
  version: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type IssueSummary = z.infer<typeof IssueSummary>;

export const IssueDetail = IssueSummary.extend({
  projectId: z.uuid(),
  projectKey: z.string(),
  description: z.string().nullable(),
  reporter: UserSummary,
  resolvedAt: z.string().nullable(),
});
export type IssueDetail = z.infer<typeof IssueDetail>;

export const IssueEvent = z.object({
  id: z.string(),
  type: z.string(),
  field: z.string().nullable(),
  oldValue: z.unknown(),
  newValue: z.unknown(),
  actor: UserSummary.nullable(),
  createdAt: z.string(),
});
export type IssueEvent = z.infer<typeof IssueEvent>;

export const Comment = z.object({
  id: z.uuid(),
  /** null once deleted: the thread keeps the slot but not the text. */
  body: z.string().nullable(),
  author: UserSummary,
  createdAt: z.string(),
  editedAt: z.string().nullable(),
  deleted: z.boolean(),
});
export type Comment = z.infer<typeof Comment>;
