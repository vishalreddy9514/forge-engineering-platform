'use client';

import { Alert } from '@forge/ui/components/alert';
import { GitCommitHorizontal } from 'lucide-react';

import { useIssueDevelopment } from '@/lib/queries/github';

import { commitTitle, GithubLink, PullRequestStateBadge, shortSha } from './github-badges';

/**
 * Pull requests and commits that mention this issue (FR-6.4), from repositories linked to the
 * project. Links come from the key appearing in a PR's title, description or branch name, or in
 * a commit message.
 */
export function DevelopmentPanel({ issueId, issueKey }: { issueId: string; issueKey: string }) {
  const { data, isPending, isError } = useIssueDevelopment(issueId);

  return (
    <section aria-labelledby="development-heading" className="grid gap-2">
      <h3 id="development-heading" className="text-sm font-semibold">
        Development
      </h3>
      {isPending ? (
        <p className="text-sm text-muted-foreground">Loading linked work…</p>
      ) : isError ? (
        <Alert variant="destructive">Linked pull requests could not be loaded.</Alert>
      ) : data.pullRequests.length === 0 && data.commits.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No pull requests or commits mention {issueKey} yet. Put{' '}
          <code className="rounded bg-muted px-1 font-mono text-xs">{issueKey}</code> in a PR title,
          description or branch name, or in a commit message.
        </p>
      ) : (
        <ul className="grid gap-2 text-sm">
          {data.pullRequests.map((pr) => (
            <li key={pr.id} className="flex flex-wrap items-center gap-2">
              <PullRequestStateBadge state={pr.state} isDraft={pr.isDraft} />
              <GithubLink href={pr.htmlUrl}>
                <span className="text-muted-foreground">
                  {pr.repository.fullName}#{pr.number}
                </span>{' '}
                {pr.title}
              </GithubLink>
              {pr.authorLogin && (
                <span className="text-xs text-muted-foreground">by {pr.authorLogin}</span>
              )}
            </li>
          ))}
          {data.commits.map((commit) => (
            <li key={commit.id} className="flex flex-wrap items-center gap-2">
              <GitCommitHorizontal className="size-4 text-muted-foreground" aria-hidden="true" />
              <GithubLink href={commit.htmlUrl}>
                <code className="font-mono text-xs">{shortSha(commit.sha)}</code>{' '}
                {commitTitle(commit.message)}
              </GithubLink>
              <span className="text-xs text-muted-foreground">
                {commit.authorLogin ?? commit.authorName ?? 'unknown'},{' '}
                <time dateTime={commit.committedAt}>
                  {new Date(commit.committedAt).toLocaleDateString()}
                </time>
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
