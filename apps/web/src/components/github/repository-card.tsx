'use client';

import type { LinkedRepository } from '@forge/types';
import { Button } from '@forge/ui/components/button';
import { Lock, RefreshCw, Unlink } from 'lucide-react';

import { GithubLink, SyncStatusText } from './github-badges';

interface RepositoryCardProps {
  repository: LinkedRepository;
  canSync: boolean;
  canUnlink: boolean;
  syncing: boolean;
  onSync: () => void;
  onUnlink: () => void;
}

export function RepositoryCard({
  repository: repo,
  canSync,
  canUnlink,
  syncing,
  onSync,
  onUnlink,
}: RepositoryCardProps) {
  const busy = syncing || repo.syncStatus === 'QUEUED' || repo.syncStatus === 'RUNNING';
  return (
    <li className="grid gap-3 rounded-xl border p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="grid gap-0.5">
          <h3 className="flex items-center gap-1.5 font-medium">
            {repo.isPrivate && (
              <Lock className="size-3.5 text-muted-foreground" aria-label="Private repository" />
            )}
            <GithubLink href={repo.htmlUrl}>{repo.fullName}</GithubLink>
          </h3>
          <p aria-live="polite">
            <SyncStatusText status={repo.syncStatus} lastSyncedAt={repo.lastSyncedAt} />
          </p>
          {repo.syncStatus === 'FAILED' && repo.lastSyncError && (
            <p className="text-xs text-destructive">{repo.lastSyncError}</p>
          )}
        </div>
        <div className="flex gap-2">
          {canSync && (
            <Button variant="outline" size="sm" onClick={onSync} disabled={busy}>
              <RefreshCw className={busy ? 'animate-spin' : undefined} aria-hidden="true" />
              Sync now
            </Button>
          )}
          {canUnlink && (
            <Button
              variant="ghost"
              size="sm"
              onClick={onUnlink}
              aria-label={`Unlink ${repo.fullName}`}
            >
              <Unlink aria-hidden="true" />
              Unlink
            </Button>
          )}
        </div>
      </div>
      <dl className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
        <div className="flex gap-1.5">
          <dt className="text-muted-foreground">Open PRs</dt>
          <dd className="font-medium tabular-nums">{repo.counts.openPullRequests}</dd>
        </div>
        <div className="flex gap-1.5">
          <dt className="text-muted-foreground">Commits synced</dt>
          <dd className="font-medium tabular-nums">{repo.counts.commits}</dd>
        </div>
        <div className="flex gap-1.5">
          <dt className="text-muted-foreground">Open issues</dt>
          <dd className="font-medium tabular-nums">{repo.counts.openIssues}</dd>
        </div>
      </dl>
      {repo.contributors.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span>Top contributors:</span>
          {repo.contributors.map((c) => (
            <span key={c.login} className="rounded-full border px-2 py-0.5">
              {c.login} <span className="tabular-nums">({c.contributions})</span>
            </span>
          ))}
        </div>
      )}
    </li>
  );
}
