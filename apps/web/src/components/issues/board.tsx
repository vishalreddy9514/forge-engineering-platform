'use client';

import { canTransition, type IssueStatus, type IssueSummary, STATUS_LABELS } from '@forge/types';
import { Alert } from '@forge/ui/components/alert';
import { cn } from '@forge/ui/lib/utils';
import Link from 'next/link';
import { type DragEvent, useState } from 'react';

import { Avatar, LabelChips, PriorityIcon, TypeIcon } from './issue-badges';

export const BOARD_COLUMNS: IssueStatus[] = ['TODO', 'IN_PROGRESS', 'IN_REVIEW', 'DONE'];

interface BoardProps {
  issues: IssueSummary[];
  projectKey: string;
  canMove: boolean;
  onMove: (issue: IssueSummary, status: IssueStatus) => Promise<unknown>;
}

/**
 * Kanban board. Cards can be dragged between columns, and every card also has a "Move to"
 * menu so the board works with a keyboard and screen readers. Only moves allowed by the
 * workflow are offered.
 */
export function Board({ issues, projectKey, canMove, onMove }: BoardProps) {
  const [dragging, setDragging] = useState<IssueSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  const move = async (issue: IssueSummary, to: IssueStatus) => {
    if (issue.status === to) return;
    setError(null);
    if (!canTransition(issue.status, to)) {
      setError(
        `${issue.key} can't move from ${STATUS_LABELS[issue.status]} to ${STATUS_LABELS[to]}.`,
      );
      return;
    }
    try {
      await onMove(issue, to);
    } catch (e) {
      setError(`${issue.key}: ${e instanceof Error ? e.message : 'could not be moved'}`);
    }
  };

  const onDrop = (event: DragEvent, to: IssueStatus) => {
    event.preventDefault();
    if (dragging) void move(dragging, to);
    setDragging(null);
  };

  return (
    <div className="grid gap-3">
      {error && <Alert variant="destructive">{error}</Alert>}
      <div className="grid gap-4 md:grid-cols-4">
        {BOARD_COLUMNS.map((status) => {
          const cards = issues.filter((i) => i.status === status);
          const droppable = dragging !== null && canTransition(dragging.status, status);
          return (
            <section
              key={status}
              aria-label={STATUS_LABELS[status]}
              onDragOver={(e) => {
                if (droppable) e.preventDefault();
              }}
              onDrop={(e) => {
                onDrop(e, status);
              }}
              className={cn(
                'flex min-h-40 flex-col gap-2 rounded-xl bg-muted/50 p-3 transition-colors',
                dragging && (droppable ? 'ring-2 ring-ring/40' : 'opacity-60'),
              )}
            >
              <h2 className="flex items-center justify-between text-sm font-semibold">
                {STATUS_LABELS[status]}
                <span className="text-muted-foreground">{cards.length}</span>
              </h2>
              {cards.map((issue) => (
                <article
                  key={issue.id}
                  draggable={canMove}
                  onDragStart={() => {
                    setDragging(issue);
                  }}
                  onDragEnd={() => {
                    setDragging(null);
                  }}
                  className="grid gap-2 rounded-lg border bg-card p-3 text-sm shadow-xs"
                >
                  <Link
                    href={`/projects/${projectKey}/issues/${issue.key}`}
                    className="font-medium hover:underline"
                  >
                    {issue.title}
                  </Link>
                  <LabelChips labels={issue.labels} />
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <TypeIcon type={issue.type} />
                    <PriorityIcon priority={issue.priority} />
                    <span className="font-mono">{issue.key}</span>
                    {issue.storyPoints !== null && (
                      <span className="rounded bg-muted px-1.5">{issue.storyPoints}</span>
                    )}
                    <span className="ml-auto">
                      <Avatar user={issue.assignee} />
                    </span>
                  </div>
                  {canMove && (
                    <select
                      aria-label={`Move ${issue.key}`}
                      value=""
                      onChange={(e) => void move(issue, e.target.value as IssueStatus)}
                      className="rounded border bg-transparent px-1 py-0.5 text-xs text-muted-foreground"
                    >
                      <option value="" disabled>
                        Move to…
                      </option>
                      {BOARD_COLUMNS.filter(
                        (to) => to !== issue.status && canTransition(issue.status, to),
                      ).map((to) => (
                        <option key={to} value={to}>
                          {STATUS_LABELS[to]}
                        </option>
                      ))}
                    </select>
                  )}
                </article>
              ))}
            </section>
          );
        })}
      </div>
    </div>
  );
}
