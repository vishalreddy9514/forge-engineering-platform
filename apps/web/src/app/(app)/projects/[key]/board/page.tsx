'use client';

import { Skeleton } from '@forge/ui/components/skeleton';
import Link from 'next/link';
import { useState } from 'react';

import { Board, BOARD_COLUMNS } from '@/components/issues/board';
import { useCan, useCurrentProject } from '@/components/projects/project-context';
import { useIssues, useMoveIssue } from '@/lib/queries/issues';

export default function BoardPage() {
  const project = useCurrentProject();
  const canMove = useCan('issue:update');
  const sprint = project.activeSprint;
  // With a sprint running, the board shows that sprint's work; the whole project is one click away.
  const [sprintOnly, setSprintOnly] = useState(true);
  const scoped = sprint !== null && sprintOnly;
  const { data, isPending } = useIssues(project.id, {
    status: BOARD_COLUMNS,
    sort: 'priority',
    ...(scoped ? { sprint: 'active' } : {}),
  });
  const moveIssue = useMoveIssue(project.id);

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
        <p className="text-muted-foreground">
          {scoped ? (
            <>
              Showing <span className="font-medium text-foreground">{sprint.name}</span>.{' '}
            </>
          ) : (
            'Backlog items are not shown on the board. '
          )}
          <Link href={`/projects/${project.key}/issues`} className="underline">
            See all issues
          </Link>
          .
        </p>
        {sprint && (
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={sprintOnly}
              onChange={(e) => {
                setSprintOnly(e.target.checked);
              }}
            />
            Only the active sprint
          </label>
        )}
      </div>
      {isPending ? (
        <Skeleton className="h-80" />
      ) : (
        <Board
          issues={data?.data ?? []}
          projectKey={project.key}
          canMove={canMove}
          onMove={(issue, status) => moveIssue.mutateAsync({ issue, status })}
        />
      )}
    </div>
  );
}
