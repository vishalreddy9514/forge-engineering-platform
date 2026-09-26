import type { IssueSummary } from '@forge/types';
import Link from 'next/link';

import { Avatar, LabelChips, PriorityIcon, StatusBadge, TypeIcon } from './issue-badges';

export function IssueList({ issues, projectKey }: { issues: IssueSummary[]; projectKey: string }) {
  return (
    <ul className="divide-y rounded-xl border" aria-label="Issues">
      {issues.map((issue) => (
        <li key={issue.id}>
          <Link
            href={`/projects/${projectKey}/issues/${issue.key}`}
            className="flex items-center gap-3 px-4 py-3 outline-none hover:bg-muted/50 focus-visible:bg-muted"
          >
            <TypeIcon type={issue.type} />
            <PriorityIcon priority={issue.priority} />
            <span className="w-20 shrink-0 font-mono text-xs text-muted-foreground">
              {issue.key}
            </span>
            <span className="min-w-0 flex-1 truncate font-medium">{issue.title}</span>
            <span className="hidden md:inline-flex">
              <LabelChips labels={issue.labels} />
            </span>
            {issue.storyPoints !== null && (
              <span className="rounded bg-muted px-1.5 text-xs" title="Story points">
                {issue.storyPoints}
              </span>
            )}
            <StatusBadge status={issue.status} />
            <Avatar user={issue.assignee} />
          </Link>
        </li>
      ))}
    </ul>
  );
}
