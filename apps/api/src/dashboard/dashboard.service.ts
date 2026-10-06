import { type AiFeature, IssuePriority, IssueStatus, type ProjectDashboard } from '@forge/types';
import { Injectable } from '@nestjs/common';

import type { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../infrastructure/database/prisma.service';
import { OPEN_ISSUES } from '../issues/open-issues';
import { SprintsService } from '../sprints/sprints.service';
import { toUserSummary, USER_SUMMARY_SELECT } from '../users/user-summary';
import { oneDecimal, weekSeries } from './weeks';

const OPEN: Prisma.IssueWhereInput = OPEN_ISSUES;
const dateOnly = (date: Date) => date.toISOString().slice(0, 10);
const zeros = <K extends string>(keys: readonly K[]) =>
  Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>;

/**
 * FR-10: a project's dashboard, aggregated on request. Every number comes from the live tables
 * with the project in the WHERE clause, so it is as current as the board and needs no cache
 * invalidation; the queries use the indexes listed in docs/database.md.
 */
@Injectable()
export class DashboardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sprints: SprintsService,
  ) {}

  async project(projectId: string, weeks: number, now = new Date()): Promise<ProjectDashboard> {
    const series = weekSeries(now, weeks);
    const since = series[0] ?? dateOnly(now);
    const sinceDate = new Date(`${since}T00:00:00Z`);

    const [issues, activeSprint, workload, pullRequests, resolution, aiUsage] = await Promise.all([
      this.issueCounts(projectId),
      this.activeSprint(projectId),
      this.workload(projectId),
      this.pullRequests(projectId, series, sinceDate),
      this.resolution(projectId, sinceDate),
      this.aiUsage(projectId, sinceDate),
    ]);
    return {
      generatedAt: now.toISOString(),
      since,
      issues,
      activeSprint,
      workload,
      pullRequests,
      resolution,
      aiUsage,
    };
  }

  private async issueCounts(projectId: string): Promise<ProjectDashboard['issues']> {
    const [byStatus, byPriority] = await Promise.all([
      this.prisma.issue.groupBy({
        by: ['status'],
        where: { projectId, deletedAt: null },
        _count: { _all: true },
      }),
      this.prisma.issue.groupBy({
        by: ['priority'],
        where: { projectId, ...OPEN },
        _count: { _all: true },
      }),
    ]);
    const status = zeros(IssueStatus.options);
    for (const row of byStatus) status[row.status] = row._count._all;
    const priority = zeros(IssuePriority.options);
    for (const row of byPriority) priority[row.priority] = row._count._all;
    const open = Object.values(priority).reduce((sum, n) => sum + n, 0);
    return { open, byStatus: status, byPriority: priority };
  }

  private async activeSprint(projectId: string): Promise<ProjectDashboard['activeSprint']> {
    const sprint = await this.prisma.sprint.findFirst({
      where: { projectId, status: 'ACTIVE' },
      include: {
        issues: {
          where: { removedAt: null, issue: { deletedAt: null } },
          select: { issue: { select: { status: true, storyPoints: true } } },
        },
      },
    });
    if (!sprint) return null;
    const issues = sprint.issues.map((m) => m.issue);
    const done = issues.filter((i) => i.status === 'DONE');
    const points = (list: typeof issues) => list.reduce((sum, i) => sum + (i.storyPoints ?? 0), 0);
    return {
      id: sprint.id,
      name: sprint.name,
      goal: sprint.goal,
      startDate: dateOnly(sprint.startDate),
      endDate: dateOnly(sprint.endDate),
      totalPoints: points(issues),
      donePoints: points(done),
      totalIssues: issues.length,
      doneIssues: done.length,
      burndown: await this.sprints.burndown(sprint.id),
    };
  }

  private async workload(projectId: string): Promise<ProjectDashboard['workload']> {
    const rows = await this.prisma.issue.groupBy({
      by: ['assigneeId'],
      where: { projectId, ...OPEN },
      _count: { _all: true },
      _sum: { storyPoints: true },
    });
    const ids = rows.flatMap((r) => (r.assigneeId ? [r.assigneeId] : []));
    const users = await this.prisma.user.findMany({
      where: { id: { in: ids } },
      select: USER_SUMMARY_SELECT,
    });
    const byId = new Map(users.map((u) => [u.id, toUserSummary(u)]));
    return rows
      .map((r) => ({
        assignee: r.assigneeId ? (byId.get(r.assigneeId) ?? null) : null,
        openIssues: r._count._all,
        openPoints: r._sum.storyPoints ?? 0,
      }))
      .sort(
        (a, b) =>
          // The unassigned pile goes last: it is a queue, not somebody's load.
          Number(a.assignee === null) - Number(b.assignee === null) ||
          b.openPoints - a.openPoints ||
          b.openIssues - a.openIssues ||
          (a.assignee?.displayName ?? '').localeCompare(b.assignee?.displayName ?? ''),
      );
  }

  private async pullRequests(
    projectId: string,
    series: string[],
    since: Date,
  ): Promise<ProjectDashboard['pullRequests']> {
    const [repositories, rows] = await Promise.all([
      this.prisma.projectRepository.count({ where: { projectId } }),
      this.prisma.$queryRaw<{ week: string; kind: 'opened' | 'merged'; n: number }[]>`
        WITH prs AS (
          SELECT pr.opened_at, pr.merged_at
          FROM github_pull_requests pr
          JOIN project_repositories pl ON pl.repository_id = pr.repository_id
          WHERE pl.project_id = ${projectId}::uuid
        )
        SELECT to_char(date_trunc('week', opened_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS week,
               'opened' AS kind, count(*)::int AS n
        FROM prs WHERE opened_at >= ${since} GROUP BY 1
        UNION ALL
        SELECT to_char(date_trunc('week', merged_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD'),
               'merged', count(*)::int
        FROM prs WHERE merged_at >= ${since} GROUP BY 1`,
    ]);
    const weeks = new Map(series.map((w) => [w, { weekStart: w, opened: 0, merged: 0 }]));
    for (const row of rows) {
      const week = weeks.get(row.week);
      if (week) week[row.kind] = row.n;
    }
    return { repositories, weeks: [...weeks.values()] };
  }

  private async resolution(
    projectId: string,
    since: Date,
  ): Promise<ProjectDashboard['resolution']> {
    const [row] = await this.prisma.$queryRaw<
      { resolved: number; median: number | null; p90: number | null }[]
    >`
      SELECT count(*)::int AS resolved,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY hours) AS median,
             percentile_cont(0.9) WITHIN GROUP (ORDER BY hours) AS p90
      FROM (
        SELECT extract(epoch FROM resolved_at - created_at) / 3600 AS hours
        FROM issues
        WHERE project_id = ${projectId}::uuid AND deleted_at IS NULL
          AND status = 'DONE' AND resolved_at >= ${since}
      ) done`;
    return {
      resolved: row?.resolved ?? 0,
      medianHours: oneDecimal(row?.median ?? null),
      p90Hours: oneDecimal(row?.p90 ?? null),
    };
  }

  private async aiUsage(projectId: string, since: Date): Promise<ProjectDashboard['aiUsage']> {
    const rows = await this.prisma.$queryRaw<
      { week: string; feature: AiFeature; requests: number; tokens: bigint; cost: number }[]
    >`
      SELECT to_char(date_trunc('week', created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS week,
             feature::text AS feature,
             count(*)::int AS requests,
             sum(input_tokens + output_tokens)::bigint AS tokens,
             sum(cost_usd)::float8 AS cost
      FROM ai_usage
      WHERE project_id = ${projectId}::uuid AND created_at >= ${since}
      GROUP BY 1, 2
      ORDER BY 1, 2`;
    const weeks = rows.map((r) => ({
      weekStart: r.week,
      feature: r.feature,
      requests: r.requests,
      tokens: Number(r.tokens),
      costUsd: Math.round(r.cost * 1e6) / 1e6,
    }));
    const totals = weeks.reduce(
      (sum, w) => ({
        requests: sum.requests + w.requests,
        tokens: sum.tokens + w.tokens,
        costUsd: sum.costUsd + w.costUsd,
      }),
      { requests: 0, tokens: 0, costUsd: 0 },
    );
    return { weeks, totals: { ...totals, costUsd: Math.round(totals.costUsd * 1e6) / 1e6 } };
  }
}
