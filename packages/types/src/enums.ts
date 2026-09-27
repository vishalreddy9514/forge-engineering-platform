import { z } from 'zod';

/**
 * Domain enumerations shared by the API (validation, Prisma mapping) and the web app
 * (select options, badges). Values are stable identifiers stored in the database, so
 * renaming one needs a migration.
 */

export const ProjectRole = z.enum(['PROJECT_MANAGER', 'DEVELOPER', 'VIEWER']);
export type ProjectRole = z.infer<typeof ProjectRole>;

export const IssueStatus = z.enum([
  'BACKLOG',
  'TODO',
  'IN_PROGRESS',
  'IN_REVIEW',
  'DONE',
  'CANCELLED',
]);
export type IssueStatus = z.infer<typeof IssueStatus>;

export const IssuePriority = z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']);
export type IssuePriority = z.infer<typeof IssuePriority>;

export const IssueType = z.enum(['BUG', 'FEATURE', 'TASK', 'CHORE']);
export type IssueType = z.infer<typeof IssueType>;

export const SprintStatus = z.enum(['PLANNED', 'ACTIVE', 'COMPLETED']);
export type SprintStatus = z.infer<typeof SprintStatus>;

export const NotificationType = z.enum([
  'ISSUE_ASSIGNED',
  'COMMENT_ADDED',
  'MENTIONED',
  'SPRINT_STARTED',
  'SPRINT_COMPLETED',
  'PULL_REQUEST_OPENED',
  'AI_JOB_COMPLETED',
  'AI_JOB_FAILED',
]);
export type NotificationType = z.infer<typeof NotificationType>;
