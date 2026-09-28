'use client';

import { SPRINT_STATUS_LABELS, type Sprint } from '@forge/types';
import { Alert } from '@forge/ui/components/alert';
import { Badge } from '@forge/ui/components/badge';
import { Button } from '@forge/ui/components/button';
import { Skeleton } from '@forge/ui/components/skeleton';
import { useState } from 'react';

import { ConfirmDialog } from '@/components/confirm-dialog';
import { useCan, useCurrentProject } from '@/components/projects/project-context';
import { BurndownChart } from '@/components/sprints/burndown-chart';
import { shortDate } from '@/components/sprints/chart-frame';
import { CompleteSprintDialog } from '@/components/sprints/complete-sprint-dialog';
import { CreateSprintDialog, suggestSprint } from '@/components/sprints/create-sprint-dialog';
import { Backlog, SprintIssues } from '@/components/sprints/sprint-issues';
import { VelocityChart } from '@/components/sprints/velocity-chart';
import { useIssues } from '@/lib/queries/issues';
import {
  useBurndown,
  useDeleteSprint,
  useSprints,
  useStartSprint,
  useVelocity,
} from '@/lib/queries/sprints';

function daysLeft(endDate: string): string {
  const today = Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`);
  const days = Math.round((Date.parse(`${endDate}T00:00:00Z`) - today) / 86_400_000);
  if (days < 0) return `ended ${String(-days)} ${-days === 1 ? 'day' : 'days'} ago`;
  if (days === 0) return 'ends today';
  return `${String(days)} ${days === 1 ? 'day' : 'days'} left`;
}

/** Points done out of the sprint's total, as a meter with the numbers beside it. */
function PointsMeter({ sprint }: { sprint: Sprint }) {
  const { total, done } = sprint.points;
  const percent = total === 0 ? 0 : Math.round((done / total) * 100);
  return (
    <div className="grid gap-1">
      <div
        role="meter"
        aria-label={`${sprint.name} progress`}
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={done}
        aria-valuetext={`${String(done)} of ${String(total)} points done`}
        className="h-2 overflow-hidden rounded-full bg-chart-1/20"
      >
        <div className="h-full rounded-full bg-chart-1" style={{ width: `${String(percent)}%` }} />
      </div>
      <p className="text-xs text-muted-foreground">
        {done} of {total} points done · {sprint.issueCount}{' '}
        {sprint.issueCount === 1 ? 'issue' : 'issues'}
      </p>
    </div>
  );
}

function SprintHeader({ sprint, children }: { sprint: Sprint; children?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="grid gap-1">
        <div className="flex items-center gap-2">
          <h3 className="text-lg font-semibold">{sprint.name}</h3>
          <Badge variant={sprint.status === 'ACTIVE' ? 'default' : 'outline'}>
            {SPRINT_STATUS_LABELS[sprint.status]}
          </Badge>
        </div>
        <p className="text-sm text-muted-foreground">
          {shortDate(sprint.startDate)} – {shortDate(sprint.endDate)}
          {sprint.status === 'ACTIVE' && ` · ${daysLeft(sprint.endDate)}`}
        </p>
        {sprint.goal && <p className="text-sm">{sprint.goal}</p>}
      </div>
      <div className="flex items-center gap-2">{children}</div>
    </div>
  );
}

function ActiveSprint({
  sprint,
  planned,
  canManage,
  projectKey,
  onCompleted,
}: {
  sprint: Sprint;
  planned: Sprint[];
  canManage: boolean;
  projectKey: string;
  onCompleted: (message: string) => void;
}) {
  const { data: burndown } = useBurndown(sprint.projectId, sprint.id);
  // Same query as the issue list below, so this shares its cache.
  const { data: issues } = useIssues(sprint.projectId, { sprint: sprint.id, sort: 'priority' });
  const openIssues = (issues?.data ?? []).filter(
    (i) => i.status !== 'DONE' && i.status !== 'CANCELLED',
  ).length;
  return (
    <section aria-label="Active sprint" className="grid gap-4 rounded-xl border p-5">
      <SprintHeader sprint={sprint}>
        {canManage && (
          <CompleteSprintDialog
            sprint={sprint}
            openIssues={openIssues}
            plannedSprints={planned}
            onCompleted={onCompleted}
          />
        )}
      </SprintHeader>
      <PointsMeter sprint={sprint} />
      {burndown ? <BurndownChart burndown={burndown} /> : <Skeleton className="h-60" />}
      <SprintIssues sprint={sprint} projectKey={projectKey} canManage={canManage} />
    </section>
  );
}

function PlannedSprint({
  sprint,
  canManage,
  canStart,
  projectKey,
}: {
  sprint: Sprint;
  canManage: boolean;
  canStart: boolean;
  projectKey: string;
}) {
  const start = useStartSprint(sprint.projectId);
  const remove = useDeleteSprint(sprint.projectId);
  const [error, setError] = useState<string | null>(null);
  return (
    <section aria-label={sprint.name} className="grid gap-3 rounded-xl border p-5">
      <SprintHeader sprint={sprint}>
        {canManage && (
          <>
            <Button
              variant="outline"
              disabled={!canStart || start.isPending}
              title={canStart ? undefined : 'Complete the active sprint first'}
              onClick={() => {
                setError(null);
                start.mutateAsync(sprint.id).catch((e: unknown) => {
                  setError(e instanceof Error ? e.message : 'The sprint could not be started.');
                });
              }}
            >
              Start sprint
            </Button>
            <ConfirmDialog
              trigger={(open) => (
                <Button variant="ghost" onClick={open}>
                  Delete
                </Button>
              )}
              title={`Delete ${sprint.name}?`}
              description="Its issues go back to the backlog. This cannot be undone."
              confirmLabel="Delete sprint"
              destructive
              onConfirm={() => remove.mutateAsync(sprint.id)}
            />
          </>
        )}
      </SprintHeader>
      {error && <Alert variant="destructive">{error}</Alert>}
      <p className="text-xs text-muted-foreground">
        {sprint.points.total} points · {sprint.issueCount}{' '}
        {sprint.issueCount === 1 ? 'issue' : 'issues'}
      </p>
      <SprintIssues sprint={sprint} projectKey={projectKey} canManage={canManage} />
    </section>
  );
}

export default function SprintsPage() {
  const project = useCurrentProject();
  const canManage = useCan('sprint:manage');
  const { data: sprints, isPending, isError } = useSprints(project.id);
  const { data: velocity } = useVelocity(project.id);
  const [notice, setNotice] = useState<string | null>(null);

  if (isPending) return <Skeleton className="h-80" />;
  if (isError) return <Alert variant="destructive">Sprints could not be loaded.</Alert>;

  const active = sprints.find((s) => s.status === 'ACTIVE');
  const planned = sprints.filter((s) => s.status === 'PLANNED');
  const completed = sprints.filter((s) => s.status === 'COMPLETED');

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-xl font-semibold">Sprints</h2>
        {canManage && (
          <CreateSprintDialog
            projectId={project.id}
            defaults={suggestSprint(project.key, sprints)}
          />
        )}
      </div>

      {notice && (
        <p role="status" className="rounded-lg border bg-muted/50 px-4 py-2 text-sm">
          {notice}
        </p>
      )}

      {active ? (
        <ActiveSprint
          sprint={active}
          planned={planned}
          canManage={canManage}
          projectKey={project.key}
          onCompleted={setNotice}
        />
      ) : (
        <p className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">
          No sprint is running. {canManage ? 'Plan one and start it when the team is ready.' : ''}
        </p>
      )}

      {planned.map((sprint) => (
        <PlannedSprint
          key={sprint.id}
          sprint={sprint}
          canManage={canManage}
          canStart={!active}
          projectKey={project.key}
        />
      ))}

      <section aria-labelledby="backlog-heading" className="grid gap-3">
        <h3 id="backlog-heading" className="text-lg font-semibold">
          Backlog
        </h3>
        <Backlog
          projectId={project.id}
          projectKey={project.key}
          sprints={sprints}
          canManage={canManage}
        />
      </section>

      <section aria-label="Velocity" className="rounded-xl border p-5">
        {velocity ? <VelocityChart velocity={velocity} /> : <Skeleton className="h-60" />}
      </section>

      {completed.length > 0 && (
        <section aria-labelledby="completed-heading" className="grid gap-2">
          <h3 id="completed-heading" className="text-lg font-semibold">
            Completed sprints
          </h3>
          <ul className="divide-y rounded-lg border text-sm">
            {completed.map((s) => (
              <li
                key={s.id}
                className="flex flex-wrap items-center justify-between gap-2 px-4 py-2"
              >
                <span className="font-medium">{s.name}</span>
                <span className="text-muted-foreground">
                  {shortDate(s.startDate)} – {shortDate(s.endDate)} · {s.points.done} of{' '}
                  {s.points.total} points done
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
