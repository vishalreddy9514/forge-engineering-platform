'use client';

import {
  type GithubIssueState,
  type LinkedRepository,
  PULL_REQUEST_STATE_LABELS,
  PullRequestState,
} from '@forge/types';
import { Alert } from '@forge/ui/components/alert';
import { Button } from '@forge/ui/components/button';
import { Label } from '@forge/ui/components/label';
import { Select } from '@forge/ui/components/select';
import { CircleCheck, CircleDot, GitCommitHorizontal } from 'lucide-react';
import { type ReactNode, useState } from 'react';

import { useCommits, useGithubIssues, usePullRequests } from '@/lib/queries/github';

import {
  commitTitle,
  GithubLink,
  IssueKeyLinks,
  PullRequestStateBadge,
  shortSha,
} from './github-badges';

type Tab = 'pulls' | 'commits' | 'issues';
const TAB_LABELS: Record<Tab, string> = {
  pulls: 'Pull requests',
  commits: 'Commits',
  issues: 'GitHub issues',
};

interface PagedList<T> {
  data?: { pages: { data: T[] }[] };
  isPending: boolean;
  isError: boolean;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  fetchNextPage: () => unknown;
}

function Paged<T extends { id: string }>({
  query,
  empty,
  render,
}: {
  query: PagedList<T>;
  empty: string;
  render: (item: T) => ReactNode;
}) {
  if (query.isPending) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (query.isError) return <Alert variant="destructive">This list could not be loaded.</Alert>;
  const items = query.data?.pages.flatMap((p) => p.data) ?? [];
  if (items.length === 0) return <p className="text-sm text-muted-foreground">{empty}</p>;
  return (
    <div className="grid gap-3">
      <ul className="divide-y rounded-xl border">
        {items.map((item) => (
          <li key={item.id} className="grid gap-1 px-4 py-3 text-sm">
            {render(item)}
          </li>
        ))}
      </ul>
      {query.hasNextPage && (
        <Button
          variant="outline"
          className="justify-self-center"
          disabled={query.isFetchingNextPage}
          onClick={() => void query.fetchNextPage()}
        >
          {query.isFetchingNextPage ? 'Loading…' : 'Load more'}
        </Button>
      )}
    </div>
  );
}

/** Synced pull requests, commits and GitHub issues from the project's repositories (FR-6.3). */
export function CodeActivity({
  projectId,
  repositories,
}: {
  projectId: string;
  repositories: LinkedRepository[];
}) {
  const [tab, setTab] = useState<Tab>('pulls');
  const [repositoryId, setRepositoryId] = useState('');
  const [prState, setPrState] = useState<PullRequestState | ''>('OPEN');
  const [issueState, setIssueState] = useState<GithubIssueState | ''>('OPEN');
  const repo = repositoryId || undefined;

  const pulls = usePullRequests(projectId, { repositoryId: repo, state: prState || undefined });
  const commits = useCommits(projectId, { repositoryId: repo });
  const issues = useGithubIssues(projectId, {
    repositoryId: repo,
    state: issueState || undefined,
  });

  return (
    <section aria-label="Code activity" className="grid gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div role="tablist" aria-label="Code activity" className="flex gap-1 border-b">
          {(Object.keys(TAB_LABELS) as Tab[]).map((name) => (
            <button
              key={name}
              type="button"
              role="tab"
              aria-selected={tab === name}
              onClick={() => {
                setTab(name);
              }}
              className={
                tab === name
                  ? '-mb-px border-b-2 border-foreground px-3 py-2 text-sm font-medium'
                  : '-mb-px border-b-2 border-transparent px-3 py-2 text-sm text-muted-foreground hover:text-foreground'
              }
            >
              {TAB_LABELS[name]}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap gap-3">
          {repositories.length > 1 && (
            <div className="grid gap-1">
              <Label htmlFor="code-repository" className="text-xs text-muted-foreground">
                Repository
              </Label>
              <Select
                id="code-repository"
                value={repositoryId}
                onChange={(e) => {
                  setRepositoryId(e.target.value);
                }}
              >
                <option value="">All repositories</option>
                {repositories.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.fullName}
                  </option>
                ))}
              </Select>
            </div>
          )}
          {tab === 'pulls' && (
            <div className="grid gap-1">
              <Label htmlFor="pr-state" className="text-xs text-muted-foreground">
                State
              </Label>
              <Select
                id="pr-state"
                value={prState}
                onChange={(e) => {
                  setPrState(e.target.value as PullRequestState | '');
                }}
              >
                <option value="">All</option>
                {PullRequestState.options.map((s) => (
                  <option key={s} value={s}>
                    {PULL_REQUEST_STATE_LABELS[s]}
                  </option>
                ))}
              </Select>
            </div>
          )}
          {tab === 'issues' && (
            <div className="grid gap-1">
              <Label htmlFor="issue-state" className="text-xs text-muted-foreground">
                State
              </Label>
              <Select
                id="issue-state"
                value={issueState}
                onChange={(e) => {
                  setIssueState(e.target.value as GithubIssueState | '');
                }}
              >
                <option value="">All</option>
                <option value="OPEN">Open</option>
                <option value="CLOSED">Closed</option>
              </Select>
            </div>
          )}
        </div>
      </div>

      <div role="tabpanel" aria-label={TAB_LABELS[tab]}>
        {tab === 'pulls' && (
          <Paged
            query={pulls}
            empty="No pull requests match."
            render={(pr) => (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <PullRequestStateBadge state={pr.state} isDraft={pr.isDraft} />
                  <GithubLink href={pr.htmlUrl}>
                    <span className="font-medium">{pr.title}</span>
                  </GithubLink>
                  <IssueKeyLinks keys={pr.issueKeys} />
                </div>
                <p className="text-xs text-muted-foreground">
                  {pr.repository.fullName}#{pr.number} · {pr.authorLogin ?? 'unknown'} wants to
                  merge <code className="font-mono">{pr.headRef}</code> into{' '}
                  <code className="font-mono">{pr.baseRef}</code> · opened{' '}
                  <time dateTime={pr.openedAt}>{new Date(pr.openedAt).toLocaleDateString()}</time>
                </p>
              </>
            )}
          />
        )}
        {tab === 'commits' && (
          <Paged
            query={commits}
            empty="No commits synced yet."
            render={(commit) => (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <GitCommitHorizontal
                    className="size-4 text-muted-foreground"
                    aria-hidden="true"
                  />
                  <GithubLink href={commit.htmlUrl}>
                    <span className="font-medium">{commitTitle(commit.message)}</span>
                  </GithubLink>
                  <IssueKeyLinks keys={commit.issueKeys} />
                </div>
                <p className="text-xs text-muted-foreground">
                  <code className="font-mono">{shortSha(commit.sha)}</code> ·{' '}
                  {commit.repository.fullName} ·{' '}
                  {commit.authorLogin ?? commit.authorName ?? 'unknown'} ·{' '}
                  <time dateTime={commit.committedAt}>
                    {new Date(commit.committedAt).toLocaleString()}
                  </time>
                </p>
              </>
            )}
          />
        )}
        {tab === 'issues' && (
          <Paged
            query={issues}
            empty="No GitHub issues match."
            render={(issue) => (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  {issue.state === 'OPEN' ? (
                    <CircleDot className="size-4 text-success" aria-label="Open" />
                  ) : (
                    <CircleCheck className="size-4 text-muted-foreground" aria-label="Closed" />
                  )}
                  <GithubLink href={issue.htmlUrl}>
                    <span className="font-medium">{issue.title}</span>
                  </GithubLink>
                  {issue.labels.map((label) => (
                    <span key={label} className="rounded-full border px-2 text-xs">
                      {label}
                    </span>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground">
                  {issue.repository.fullName}#{issue.number} · {issue.authorLogin ?? 'unknown'} ·{' '}
                  {issue.commentsCount} comments
                </p>
              </>
            )}
          />
        )}
      </div>
    </section>
  );
}
