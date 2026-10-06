import type { IssueStatus } from '@forge/types';

import type { Prisma } from '../generated/prisma/client';

/** Every status that is not terminal (DONE, CANCELLED). */
export const OPEN_STATUSES = [
  'BACKLOG',
  'TODO',
  'IN_PROGRESS',
  'IN_REVIEW',
] as const satisfies readonly IssueStatus[];

/**
 * Live, open issues. Written as `status IN (open)` rather than `NOT IN (terminal)`: PostgreSQL
 * can answer the former from issues_active_by_status_idx alone (1.9 ms for 21k open issues of
 * 100k, against 5.6 ms, and a full scan before VACUUM; docs/performance.md).
 */
export const OPEN_ISSUES = {
  deletedAt: null,
  status: { in: [...OPEN_STATUSES] },
} as const satisfies Prisma.IssueWhereInput;
