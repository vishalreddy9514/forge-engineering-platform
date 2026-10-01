import { z } from 'zod';

import { IssuePriority, IssueStatus } from './enums';
import { UserSummary } from './projects';
import { Burndown } from './sprints';

/** What an AI call was for; every call records one in `ai_usage` (NFR-12). */
export const AiFeature = z.enum([
  'ISSUE_DRAFT',
  'ISSUE_SUMMARY',
  'RELATED_ISSUES',
  'CHAT',
  'SEMANTIC_SEARCH',
  'PR_REVIEW',
  'EMBEDDING',
]);
export type AiFeature = z.infer<typeof AiFeature>;

export const AI_FEATURE_LABELS: Record<AiFeature, string> = {
  ISSUE_DRAFT: 'Issue drafts',
  ISSUE_SUMMARY: 'Summaries',
  RELATED_ISSUES: 'Related issues',
  CHAT: 'Assistant',
  SEMANTIC_SEARCH: 'Search',
  PR_REVIEW: 'Code review',
  EMBEDDING: 'Indexing',
};

export const DashboardQuery = z.object({
  /** How many weeks of history the weekly series cover, the current week included. */
  weeks: z.coerce.number().int().min(1).max(26).default(8),
});
export type DashboardQuery = z.infer<typeof DashboardQuery>;

/** A Monday (UTC), as YYYY-MM-DD: weeks run Monday to Sunday in UTC. */
const WeekStart = z.iso.date();
const Count = z.number().int().nonnegative();

/** FR-10: one project's dashboard, computed on request from the live tables. */
export const ProjectDashboard = z.object({
  generatedAt: z.iso.datetime(),
  /** The first week the weekly series cover. */
  since: WeekStart,
  issues: z.object({
    /** Not DONE or CANCELLED. */
    open: Count,
    byStatus: z.record(IssueStatus, Count),
    /** Open issues only: what is still to do, by urgency. */
    byPriority: z.record(IssuePriority, Count),
  }),
  activeSprint: z
    .object({
      id: z.uuid(),
      name: z.string(),
      goal: z.string().nullable(),
      startDate: z.string(),
      endDate: z.string(),
      /** Points of the issues in the sprint now, and how many of them are done. */
      totalPoints: Count,
      donePoints: Count,
      totalIssues: Count,
      doneIssues: Count,
      burndown: Burndown,
    })
    .nullable(),
  /** Open issues per assignee, most points first; `assignee: null` is the unassigned pile. */
  workload: z.array(
    z.object({
      assignee: UserSummary.nullable(),
      openIssues: Count,
      openPoints: Count,
    }),
  ),
  pullRequests: z.object({
    /** Repositories linked to the project; zero means there is no PR data to show. */
    repositories: Count,
    /** Every week of the period, oldest first, empty weeks as zero. */
    weeks: z.array(z.object({ weekStart: WeekStart, opened: Count, merged: Count })),
  }),
  /** Time from creation to DONE for issues finished in the period (cancelled ones excluded). */
  resolution: z.object({
    resolved: Count,
    medianHours: z.number().nonnegative().nullable(),
    p90Hours: z.number().nonnegative().nullable(),
  }),
  aiUsage: z.object({
    /** One row per week and feature that had calls (sparse), oldest week first. */
    weeks: z.array(
      z.object({
        weekStart: WeekStart,
        feature: AiFeature,
        requests: Count,
        tokens: Count,
        costUsd: z.number().nonnegative(),
      }),
    ),
    totals: z.object({ requests: Count, tokens: Count, costUsd: z.number().nonnegative() }),
  }),
});
export type ProjectDashboard = z.infer<typeof ProjectDashboard>;
