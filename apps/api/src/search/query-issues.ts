import type { IssueStatus } from '@forge/types';

import type { ToolIssue } from '../ai/ai.client';
import type { QueryIssuesArgs } from '../ai/ai.wire';
import type { Prisma } from '../generated/prisma/client';
import type { PrismaService } from '../infrastructure/database/prisma.service';
import { issueUrl } from './source-normaliser';

export const TOOL_RESULT_LIMIT = 20;

const STATUS_GROUPS: Record<NonNullable<QueryIssuesArgs['status']>, IssueStatus[]> = {
  open: ['BACKLOG', 'TODO', 'IN_PROGRESS', 'IN_REVIEW'],
  in_progress: ['IN_PROGRESS', 'IN_REVIEW'],
  done: ['DONE'],
};

export interface ReadableProject {
  id: string;
  key: string;
  name: string;
}

/**
 * The assistant's one tool (architecture §7.2): structured questions ("which bugs were fixed
 * last sprint") answered from the database, not by similarity. It runs here, in the API, with
 * the user's own project list: the model chooses filters, never scope. A project key the user
 * cannot read matches nothing.
 */
export async function queryIssues(
  prisma: PrismaService,
  args: QueryIssuesArgs,
  readable: ReadableProject[],
  now = new Date(),
): Promise<{ total: number; issues: ToolIssue[] }> {
  const project = readable.find((p) => p.key === args.project_key.toUpperCase());
  if (!project) return { total: 0, issues: [] };

  const where: Prisma.IssueWhereInput[] = [{ projectId: project.id, deletedAt: null }];
  if (args.type) where.push({ type: args.type });
  if (args.priority) where.push({ priority: args.priority });
  if (args.status) where.push({ status: { in: STATUS_GROUPS[args.status] } });
  if (args.updated_within_days) {
    where.push({
      updatedAt: { gte: new Date(now.getTime() - args.updated_within_days * 86_400_000) },
    });
  }
  if (args.sprint) {
    const sprint = await prisma.sprint.findFirst({
      where:
        args.sprint === 'active'
          ? { projectId: project.id, status: 'ACTIVE' }
          : { projectId: project.id, status: 'COMPLETED' },
      orderBy: args.sprint === 'active' ? { startedAt: 'desc' } : { completedAt: 'desc' },
      select: { id: true },
    });
    if (!sprint) return { total: 0, issues: [] };
    where.push({ sprintIssues: { some: { sprintId: sprint.id } } });
  }

  const [total, rows] = await Promise.all([
    prisma.issue.count({ where: { AND: where } }),
    prisma.issue.findMany({
      where: { AND: where },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: TOOL_RESULT_LIMIT,
      select: {
        id: true,
        number: true,
        title: true,
        type: true,
        status: true,
        priority: true,
        updatedAt: true,
        assignee: { select: { displayName: true } },
      },
    }),
  ]);
  return {
    total,
    issues: rows.map((row) => ({
      id: row.id,
      projectId: project.id,
      key: `${project.key}-${String(row.number)}`,
      title: row.title,
      type: row.type,
      status: row.status,
      priority: row.priority,
      assignee: row.assignee?.displayName ?? null,
      updatedAt: row.updatedAt.toISOString(),
      url: issueUrl(project.key, row.number),
    })),
  };
}

/** A short, human description of the query for the chat UI ("Looking up done bugs in PAY"). */
export function describeQuery(args: QueryIssuesArgs): string {
  const parts = [
    args.status?.replace('_', ' '),
    args.priority?.toLowerCase(),
    args.type ? `${args.type.toLowerCase()}s` : 'issues',
    `in ${args.project_key}`,
    args.sprint === 'active' ? 'in the active sprint' : null,
    args.sprint === 'last_completed' ? 'in the last completed sprint' : null,
    args.updated_within_days
      ? `updated in the last ${String(args.updated_within_days)} days`
      : null,
  ].filter(Boolean);
  return `Looking up ${parts.join(' ')}`;
}
