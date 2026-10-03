'use client';

import {
  AI_FEATURE_LABELS,
  type AiFeature,
  IssuePriority,
  IssueStatus,
  PRIORITY_LABELS,
  type ProjectDashboard as Dashboard,
  STATUS_LABELS,
} from '@forge/types';
import { Card, CardContent, CardHeader, CardTitle } from '@forge/ui/components/card';
import { Label } from '@forge/ui/components/label';
import { Select } from '@forge/ui/components/select';
import { Skeleton } from '@forge/ui/components/skeleton';
import Link from 'next/link';
import { useId, useState } from 'react';

import { useDashboard } from '@/lib/queries/dashboard';

import { BurndownChart } from '../sprints/burndown-chart';
import { shortDate } from '../sprints/chart-frame';
import { BarList } from './bar-list';
import { compact, duration, usd } from './format';
import { WeeklyColumns } from './weekly-columns';

const WINDOWS = [4, 8, 12, 26] as const;

function Tile({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="grid gap-1 rounded-xl border bg-card p-4">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="text-2xl font-semibold tabular-nums">{value}</dd>
      {detail && <dd className="text-xs text-muted-foreground">{detail}</dd>}
    </div>
  );
}

/** Done points out of the sprint's points, as a meter on a muted track. */
function SprintMeter({ done, total }: { done: number; total: number }) {
  const pct = total === 0 ? 0 : Math.round((done / total) * 100);
  return (
    <div
      role="meter"
      aria-label="Sprint points done"
      aria-valuemin={0}
      aria-valuemax={total}
      aria-valuenow={done}
      aria-valuetext={`${String(done)} of ${String(total)} points done`}
      className="h-2 overflow-hidden rounded-full bg-muted"
    >
      <div className="h-full rounded-full bg-chart-1" style={{ width: `${String(pct)}%` }} />
    </div>
  );
}

/** Per-week totals of the sparse AI usage rows, aligned to the dense list of weeks. */
export function aiTokensByWeek(dashboard: Dashboard, weeks: string[]): number[] {
  const byWeek = new Map<string, number>();
  for (const row of dashboard.aiUsage.weeks) {
    byWeek.set(row.weekStart, (byWeek.get(row.weekStart) ?? 0) + row.tokens);
  }
  return weeks.map((w) => byWeek.get(w) ?? 0);
}

/** AI usage for the whole period per feature, most expensive first. */
export function aiByFeature(dashboard: Dashboard) {
  const totals = new Map<AiFeature, { requests: number; tokens: number; costUsd: number }>();
  for (const row of dashboard.aiUsage.weeks) {
    const t = totals.get(row.feature) ?? { requests: 0, tokens: 0, costUsd: 0 };
    totals.set(row.feature, {
      requests: t.requests + row.requests,
      tokens: t.tokens + row.tokens,
      costUsd: t.costUsd + row.costUsd,
    });
  }
  return [...totals.entries()]
    .map(([feature, t]) => ({ feature, ...t }))
    .sort((a, b) => b.costUsd - a.costUsd || b.requests - a.requests);
}

function DashboardBody({ dashboard, projectKey }: { dashboard: Dashboard; projectKey: string }) {
  const { issues, activeSprint, workload, pullRequests, resolution, aiUsage } = dashboard;
  const weeks = pullRequests.weeks.map((w) => w.weekStart);
  const merged = pullRequests.weeks.reduce((sum, w) => sum + w.merged, 0);
  const opened = pullRequests.weeks.reduce((sum, w) => sum + w.opened, 0);
  const features = aiByFeature(dashboard);

  return (
    <div className="grid gap-6">
      <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <Tile
          label="Open issues"
          value={String(issues.open)}
          detail={`${String(issues.byPriority.CRITICAL)} critical · ${String(issues.byPriority.HIGH)} high`}
        />
        {activeSprint ? (
          <div className="grid gap-1 rounded-xl border bg-card p-4">
            <dt className="text-sm text-muted-foreground">{activeSprint.name}</dt>
            <dd className="text-2xl font-semibold tabular-nums">
              {activeSprint.donePoints}
              <span className="text-base font-normal text-muted-foreground">
                {' '}
                / {activeSprint.totalPoints} pts
              </span>
            </dd>
            <dd className="grid gap-1">
              <SprintMeter done={activeSprint.donePoints} total={activeSprint.totalPoints} />
              <span className="text-xs text-muted-foreground">
                {activeSprint.doneIssues} of {activeSprint.totalIssues} issues · ends{' '}
                {shortDate(activeSprint.endDate)}
              </span>
            </dd>
          </div>
        ) : (
          <Tile label="Active sprint" value="None" detail="Start one on the Sprints tab" />
        )}
        <Tile
          label="Median resolution"
          value={duration(resolution.medianHours)}
          detail={
            resolution.resolved === 0
              ? 'No issues done in this period'
              : `p90 ${duration(resolution.p90Hours)} · ${String(resolution.resolved)} done`
          }
        />
        <Tile
          label="PRs merged"
          value={pullRequests.repositories === 0 ? '–' : String(merged)}
          detail={
            pullRequests.repositories === 0 ? 'No repository linked' : `${String(opened)} opened`
          }
        />
        <Tile
          label="AI cost"
          value={usd(aiUsage.totals.costUsd)}
          detail={`${String(aiUsage.totals.requests)} requests · ${compact(aiUsage.totals.tokens)} tokens`}
        />
      </dl>

      <div className="grid gap-6 lg:grid-cols-3">
        <Card>
          <CardContent>
            <BarList
              title="Issues by status"
              rows={IssueStatus.options.map((s) => ({
                key: s,
                label: STATUS_LABELS[s],
                value: issues.byStatus[s],
              }))}
              empty="No issues yet."
            />
          </CardContent>
        </Card>
        <Card>
          <CardContent>
            <BarList
              title="Open issues by priority"
              rows={IssuePriority.options.map((p) => ({
                key: p,
                label: PRIORITY_LABELS[p],
                value: issues.byPriority[p],
              }))}
              empty="Nothing open."
            />
          </CardContent>
        </Card>
        <Card>
          <CardContent>
            <BarList
              title="Workload: open points per person"
              rows={workload.map((w) => ({
                key: w.assignee?.id ?? 'unassigned',
                label: w.assignee?.displayName ?? 'Unassigned',
                value: w.openPoints,
                detail: `${String(w.openIssues)} ${w.openIssues === 1 ? 'issue' : 'issues'}`,
              }))}
              format={(v) => `${String(v)} pts`}
              empty="No open issues."
            />
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-6">
        <Card>
          <CardHeader>
            <CardTitle>
              <h3>Active sprint</h3>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {activeSprint ? (
              <div className="grid gap-2">
                {activeSprint.goal && (
                  <p className="text-sm text-muted-foreground">Goal: {activeSprint.goal}</p>
                )}
                <BurndownChart burndown={activeSprint.burndown} />
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                No sprint is running.{' '}
                <Link href={`/projects/${projectKey}/sprints`} className="underline">
                  Plan one
                </Link>
                .
              </p>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-6">
        <Card>
          <CardHeader>
            <CardTitle>
              <h3>Pull requests</h3>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {pullRequests.repositories === 0 ? (
              <p className="text-sm text-muted-foreground">
                No repository is linked.{' '}
                <Link href={`/projects/${projectKey}/code`} className="underline">
                  Link one on the Code tab
                </Link>{' '}
                to see pull request activity.
              </p>
            ) : (
              <WeeklyColumns
                title="Opened and merged per week"
                weeks={weeks}
                series={[
                  {
                    label: 'Opened',
                    slot: 'chart-2',
                    values: pullRequests.weeks.map((w) => w.opened),
                  },
                  {
                    label: 'Merged',
                    slot: 'chart-1',
                    values: pullRequests.weeks.map((w) => w.merged),
                  },
                ]}
                empty="No pull request activity in this period."
              />
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>
              <h3>AI usage</h3>
            </CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4">
            <WeeklyColumns
              title="Tokens per week"
              summary={`${usd(aiUsage.totals.costUsd)} estimated`}
              weeks={weeks}
              series={[
                { label: 'Tokens', slot: 'chart-1', values: aiTokensByWeek(dashboard, weeks) },
              ]}
              format={compact}
              empty="No AI requests in this period."
            />
            {features.length > 0 && (
              <table className="w-full text-left text-xs tabular-nums">
                <caption className="sr-only">AI usage by feature</caption>
                <thead className="text-muted-foreground">
                  <tr>
                    <th className="py-1 font-medium">Feature</th>
                    <th className="py-1 text-right font-medium">Requests</th>
                    <th className="py-1 text-right font-medium">Tokens</th>
                    <th className="py-1 text-right font-medium">Est. cost</th>
                  </tr>
                </thead>
                <tbody>
                  {features.map((f) => (
                    <tr key={f.feature} className="border-t">
                      <td className="py-1">{AI_FEATURE_LABELS[f.feature]}</td>
                      <td className="py-1 text-right">{f.requests}</td>
                      <td className="py-1 text-right">{compact(f.tokens)}</td>
                      <td className="py-1 text-right">{usd(f.costUsd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

/** FR-10: the project dashboard, on the project's Overview tab. */
export function ProjectDashboard({
  projectId,
  projectKey,
}: {
  projectId: string;
  projectKey: string;
}) {
  const [weeks, setWeeks] = useState<number>(8);
  const selectId = useId();
  const { data, isPending, isError, isFetching } = useDashboard(projectId, weeks);

  return (
    <section aria-labelledby={`${selectId}-heading`} className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id={`${selectId}-heading`} className="text-lg font-semibold">
          Dashboard
        </h2>
        <div className="flex items-center gap-2 text-sm">
          {data && (
            <span className="text-muted-foreground" aria-live="polite">
              {isFetching ? 'Updating…' : `Since ${shortDate(data.since)}`}
            </span>
          )}
          <Label htmlFor={selectId} className="sr-only">
            Period
          </Label>
          <Select
            id={selectId}
            value={weeks}
            onChange={(e) => {
              setWeeks(Number(e.target.value));
            }}
          >
            {WINDOWS.map((w) => (
              <option key={w} value={w}>
                Last {w} weeks
              </option>
            ))}
          </Select>
        </div>
      </div>
      {isPending ? (
        <div className="grid gap-4">
          <Skeleton className="h-28" />
          <Skeleton className="h-64" />
        </div>
      ) : isError ? (
        <p role="alert" className="rounded-lg border p-4 text-sm text-destructive">
          The dashboard could not be loaded. Try again in a moment.
        </p>
      ) : (
        <DashboardBody dashboard={data} projectKey={projectKey} />
      )}
    </section>
  );
}
