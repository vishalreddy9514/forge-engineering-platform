'use client';

import { Skeleton } from '@forge/ui/components/skeleton';
import { ArrowLeft, ExternalLink } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';

import { AiReviewPanel } from '@/components/github/ai-review-panel';
import { IssueKeyLinks, PullRequestStateBadge } from '@/components/github/github-badges';
import { Markdown } from '@/components/markdown';
import { useCan, useCurrentProject } from '@/components/projects/project-context';
import { usePullRequest } from '@/lib/queries/reviews';

export default function PullRequestPage() {
  const project = useCurrentProject();
  const { pullRequestId } = useParams<{ pullRequestId: string }>();
  const { data: pr, isPending, isError } = usePullRequest(project.id, pullRequestId);
  const canReview = useCan('ai:write') && !project.archivedAt;

  return (
    <div className="grid gap-5">
      <Link
        href={`/projects/${project.key}/code`}
        className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" aria-hidden="true" />
        Code
      </Link>
      {isPending ? (
        <Skeleton className="h-40" />
      ) : isError ? (
        <p className="text-sm text-muted-foreground">
          This pull request doesn&apos;t exist, or its repository isn&apos;t linked to this project.
        </p>
      ) : (
        <>
          <header className="grid gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <PullRequestStateBadge state={pr.state} isDraft={pr.isDraft} />
              <h2 className="text-2xl font-semibold">{pr.title}</h2>
              <span className="text-muted-foreground">#{pr.number}</span>
            </div>
            <p className="text-sm text-muted-foreground">
              {pr.repository.fullName} · {pr.authorLogin ?? 'unknown'} wants to merge{' '}
              <code className="font-mono">{pr.headRef}</code> into{' '}
              <code className="font-mono">{pr.baseRef}</code>
              {pr.changedFiles !== null &&
                ` · ${String(pr.changedFiles)} files, +${String(pr.additions ?? 0)} −${String(pr.deletions ?? 0)}`}
            </p>
            <div className="flex flex-wrap items-center gap-3 text-sm">
              <IssueKeyLinks keys={pr.issueKeys} />
              <a
                href={pr.htmlUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1 hover:underline"
              >
                Open on GitHub
                <ExternalLink className="size-3.5" aria-hidden="true" />
              </a>
            </div>
          </header>
          {pr.body ? (
            <Markdown>{pr.body}</Markdown>
          ) : (
            <p className="text-sm text-muted-foreground">No description.</p>
          )}
          <AiReviewPanel
            projectId={project.id}
            pullRequestId={pr.id}
            filesUrl={`${pr.htmlUrl}/files`}
            canRequest={canReview}
          />
        </>
      )}
    </div>
  );
}
