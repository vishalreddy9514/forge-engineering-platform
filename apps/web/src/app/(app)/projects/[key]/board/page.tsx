'use client';

import { Skeleton } from '@forge/ui/components/skeleton';
import Link from 'next/link';

import { Board, BOARD_COLUMNS } from '@/components/issues/board';
import { useCan, useCurrentProject } from '@/components/projects/project-context';
import { useIssues, useMoveIssue } from '@/lib/queries/issues';

export default function BoardPage() {
  const project = useCurrentProject();
  const canMove = useCan('issue:update');
  const { data, isPending } = useIssues(project.id, { status: BOARD_COLUMNS, sort: 'priority' });
  const moveIssue = useMoveIssue(project.id);

  if (isPending) return <Skeleton className="h-80" />;
  return (
    <div className="grid gap-3">
      <p className="text-sm text-muted-foreground">
        Backlog items are not shown on the board.{' '}
        <Link href={`/projects/${project.key}/issues`} className="underline">
          See all issues
        </Link>
        .
      </p>
      <Board
        issues={data?.data ?? []}
        projectKey={project.key}
        canMove={canMove}
        onMove={(issue, status) => moveIssue.mutateAsync({ issue, status })}
      />
    </div>
  );
}
