'use client';

import type { RelatedIssue } from '@forge/types';
import { Skeleton } from '@forge/ui/components/skeleton';
import { Sparkles } from 'lucide-react';
import Link from 'next/link';

import { StatusBadge, TypeIcon } from '@/components/issues/issue-badges';
import { useAiStatus } from '@/lib/queries/ai';
import { useRelatedIssues } from '@/lib/queries/search';

export function RelatedIssueList({
  issues,
  projectKey,
}: {
  issues: RelatedIssue[];
  projectKey: string;
}) {
  return (
    <ul className="grid gap-1.5 text-sm">
      {issues.map((issue) => (
        <li key={issue.id} className="flex items-center gap-2">
          <TypeIcon type={issue.type} />
          <Link
            href={`/projects/${projectKey}/issues/${issue.key}`}
            className="min-w-0 flex-1 truncate hover:underline"
          >
            <span className="font-mono text-muted-foreground">{issue.key}</span> {issue.title}
          </Link>
          <StatusBadge status={issue.status} />
          <span
            className="w-10 text-right text-xs text-muted-foreground tabular-nums"
            title="Similarity"
          >
            {Math.round(issue.score * 100)}%
          </span>
        </li>
      ))}
    </ul>
  );
}

/** FR-7.3 on the issue page: issues worded like this one, which may be duplicates. */
export function RelatedIssuesPanel({
  issueId,
  projectKey,
  canUse,
}: {
  issueId: string;
  projectKey: string;
  canUse: boolean;
}) {
  const { data: status } = useAiStatus();
  const enabled = canUse && (status?.available ?? false);
  const { data, isPending, isError } = useRelatedIssues(issueId, enabled);
  if (!enabled) return null;

  return (
    <section aria-labelledby="related-heading" className="grid gap-2">
      <h2 id="related-heading" className="flex items-center gap-1.5 text-sm font-semibold">
        <Sparkles className="size-4" aria-hidden="true" />
        Related issues
      </h2>
      {isPending ? (
        <Skeleton className="h-12" />
      ) : isError ? (
        <p className="text-sm text-muted-foreground">Related issues could not be loaded.</p>
      ) : data.data.length === 0 ? (
        <p className="text-sm text-muted-foreground">No similar issues in this project.</p>
      ) : (
        <RelatedIssueList issues={data.data} projectKey={projectKey} />
      )}
    </section>
  );
}
