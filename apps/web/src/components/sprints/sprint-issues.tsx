'use client';

import type { IssueSummary, Sprint } from '@forge/types';
import { Select } from '@forge/ui/components/select';
import { Skeleton } from '@forge/ui/components/skeleton';
import { X } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';

import { PriorityIcon, StatusBadge, TypeIcon } from '@/components/issues/issue-badges';
import { useIssues } from '@/lib/queries/issues';
import { useAddToSprint, useRemoveFromSprint } from '@/lib/queries/sprints';

const OPEN = ['BACKLOG', 'TODO', 'IN_PROGRESS', 'IN_REVIEW'];

function Row({
  issue,
  projectKey,
  action,
}: {
  issue: IssueSummary;
  projectKey: string;
  action?: React.ReactNode;
}) {
  return (
    <li className="flex items-center gap-3 px-3 py-2 text-sm">
      <TypeIcon type={issue.type} />
      <PriorityIcon priority={issue.priority} />
      <Link
        href={`/projects/${projectKey}/issues/${issue.key}`}
        className="w-16 shrink-0 font-mono text-xs text-muted-foreground hover:underline"
      >
        {issue.key}
      </Link>
      <span className="min-w-0 flex-1 truncate">{issue.title}</span>
      {issue.storyPoints !== null && (
        <span className="rounded bg-muted px-1.5 text-xs tabular-nums" title="Story points">
          {issue.storyPoints}
        </span>
      )}
      <StatusBadge status={issue.status} />
      {action}
    </li>
  );
}

/** Issues in one sprint, with a remove action for people who plan sprints. */
export function SprintIssues({
  sprint,
  projectKey,
  canManage,
}: {
  sprint: Sprint;
  projectKey: string;
  canManage: boolean;
}) {
  const { data, isPending } = useIssues(sprint.projectId, { sprint: sprint.id, sort: 'priority' });
  const remove = useRemoveFromSprint(sprint.projectId);
  const [error, setError] = useState<string | null>(null);
  const issues = data?.data ?? [];

  if (isPending) return <Skeleton className="h-16" />;
  if (issues.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No issues yet. Add some from the backlog below.
      </p>
    );
  }
  return (
    <>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <ul className="divide-y rounded-lg border" aria-label={`Issues in ${sprint.name}`}>
        {issues.map((issue) => (
          <Row
            key={issue.id}
            issue={issue}
            projectKey={projectKey}
            action={
              canManage && sprint.status !== 'COMPLETED' ? (
                <button
                  type="button"
                  aria-label={`Remove ${issue.key} from ${sprint.name}`}
                  className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                  onClick={() => {
                    setError(null);
                    remove
                      .mutateAsync({ sprintId: sprint.id, issueId: issue.id })
                      .catch((e: unknown) => {
                        setError(e instanceof Error ? e.message : 'Could not remove the issue.');
                      });
                  }}
                >
                  <X className="size-4" aria-hidden="true" />
                </button>
              ) : undefined
            }
          />
        ))}
      </ul>
    </>
  );
}

/** Open issues not in any sprint, each with an "Add to…" menu listing the open sprints. */
export function Backlog({
  projectId,
  projectKey,
  sprints,
  canManage,
}: {
  projectId: string;
  projectKey: string;
  sprints: Sprint[];
  canManage: boolean;
}) {
  const { data, isPending } = useIssues(projectId, {
    sprint: 'none',
    status: OPEN,
    sort: 'priority',
  });
  const add = useAddToSprint(projectId);
  const [error, setError] = useState<string | null>(null);
  const issues = data?.data ?? [];
  const targets = sprints.filter((s) => s.status !== 'COMPLETED');

  if (isPending) return <Skeleton className="h-24" />;
  if (issues.length === 0) {
    return <p className="text-sm text-muted-foreground">The backlog is empty.</p>;
  }
  return (
    <>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <ul className="divide-y rounded-lg border" aria-label="Backlog">
        {issues.map((issue) => (
          <Row
            key={issue.id}
            issue={issue}
            projectKey={projectKey}
            action={
              canManage && targets.length > 0 ? (
                <Select
                  aria-label={`Add ${issue.key} to a sprint`}
                  value=""
                  className="h-8 w-36 text-xs"
                  onChange={(e) => {
                    setError(null);
                    add
                      .mutateAsync({ sprintId: e.target.value, issueIds: [issue.id] })
                      .catch((err: unknown) => {
                        setError(err instanceof Error ? err.message : 'Could not add the issue.');
                      });
                  }}
                >
                  <option value="" disabled>
                    Add to sprint…
                  </option>
                  {targets.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </Select>
              ) : undefined
            }
          />
        ))}
      </ul>
    </>
  );
}
