import { z } from 'zod';

import { SprintStatus } from './enums';

const Name = z.string().trim().min(1, 'Enter a name').max(100, 'Use at most 100 characters');
const Goal = z.string().trim().max(500, 'Keep the goal under 500 characters');
const Day = z.iso.date({ message: 'Use a date like 2026-10-31' });

/** Longest sprint the API accepts: long enough for any real cadence, short enough to catch typos. */
export const MAX_SPRINT_DAYS = 8 * 7;

const dayCount = (start: string, end: string) =>
  Math.round((Date.parse(end) - Date.parse(start)) / 86_400_000) + 1;

interface DateRange {
  startDate?: string;
  endDate?: string;
}
const datesInOrder = (value: DateRange) =>
  !value.startDate || !value.endDate || value.endDate >= value.startDate;
const notTooLong = (value: DateRange) =>
  !value.startDate || !value.endDate || dayCount(value.startDate, value.endDate) <= MAX_SPRINT_DAYS;

export const CreateSprintRequest = z
  .object({
    name: Name,
    goal: Goal.optional(),
    startDate: Day,
    endDate: Day,
  })
  .refine(datesInOrder, {
    path: ['endDate'],
    message: 'The end date must be on or after the start',
  })
  .refine(notTooLong, {
    path: ['endDate'],
    message: `Sprints can be at most ${MAX_SPRINT_DAYS} days`,
  });
export type CreateSprintRequest = z.infer<typeof CreateSprintRequest>;

export const UpdateSprintRequest = z
  .object({
    name: Name.optional(),
    goal: Goal.nullable().optional(),
    startDate: Day.optional(),
    endDate: Day.optional(),
  })
  .refine((body) => Object.keys(body).length > 0, {
    message: 'Nothing to update',
  })
  .refine(datesInOrder, {
    path: ['endDate'],
    message: 'The end date must be on or after the start',
  })
  .refine(notTooLong, {
    path: ['endDate'],
    message: `Sprints can be at most ${MAX_SPRINT_DAYS} days`,
  });
export type UpdateSprintRequest = z.infer<typeof UpdateSprintRequest>;

/**
 * Completing a sprint: unfinished issues go back to the backlog, or into a planned sprint of
 * the same project (FR-5.2).
 */
export const CompleteSprintRequest = z.object({
  moveOpenIssuesTo: z.union([z.literal('backlog'), z.uuid()]).default('backlog'),
});
export type CompleteSprintRequest = z.infer<typeof CompleteSprintRequest>;

export const SprintIssuesRequest = z.object({
  issueIds: z
    .array(z.uuid())
    .min(1, 'Choose at least one issue')
    .max(100, 'Add at most 100 issues at a time')
    .refine((ids) => new Set(ids).size === ids.length, 'Each issue can only be listed once'),
});
export type SprintIssuesRequest = z.infer<typeof SprintIssuesRequest>;

export const Sprint = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  name: z.string(),
  goal: z.string().nullable(),
  status: SprintStatus,
  startDate: z.string(),
  endDate: z.string(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  /** Issues currently in the sprint (for a completed sprint: those it finished with). */
  issueCount: z.number().int(),
  /** Story points of those issues, and how many of them are done. */
  points: z.object({ total: z.number().int(), done: z.number().int() }),
});
export type Sprint = z.infer<typeof Sprint>;

/** Remaining story points at the end of each day (FR-5.5), built from issue history. */
export const Burndown = z.object({
  sprintId: z.uuid(),
  startDate: z.string(),
  endDate: z.string(),
  /** Points in the sprint when it started. */
  committed: z.number().int(),
  days: z.array(
    z.object({
      date: z.string(),
      /** null for days that have not happened yet. */
      remaining: z.number().int().nullable(),
      /** Straight line from `committed` on day one to zero on the last day. */
      ideal: z.number(),
      /** Points added to (positive) or removed from (negative) the sprint that day. */
      scopeChange: z.number().int(),
    }),
  ),
});
export type Burndown = z.infer<typeof Burndown>;

/** Completed story points per sprint over the last completed sprints (FR-5.4). */
export const Velocity = z.object({
  sprints: z.array(
    z.object({
      id: z.uuid(),
      name: z.string(),
      completedAt: z.string(),
      committed: z.number().int(),
      completed: z.number().int(),
    }),
  ),
  /** Mean completed points over the sprints listed; null when there are none. */
  average: z.number().nullable(),
});
export type Velocity = z.infer<typeof Velocity>;

export const VelocityQuery = z.object({
  sprints: z.coerce.number().int().min(1).max(20).default(6),
});
export type VelocityQuery = z.infer<typeof VelocityQuery>;

export const SPRINT_STATUS_LABELS: Record<SprintStatus, string> = {
  PLANNED: 'Planned',
  ACTIVE: 'Active',
  COMPLETED: 'Completed',
};
