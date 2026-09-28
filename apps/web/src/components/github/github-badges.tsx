import {
  commitTitle,
  type PullRequestState,
  PULL_REQUEST_STATE_LABELS,
  type GithubSyncStatus,
  SYNC_STATUS_LABELS,
} from '@forge/types';
import { cn } from '@forge/ui/lib/utils';
import {
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  type LucideIcon,
} from 'lucide-react';
import Link from 'next/link';

const PR_STYLES: Record<PullRequestState | 'DRAFT', { icon: LucideIcon; className: string }> = {
  OPEN: { icon: GitPullRequest, className: 'bg-success/15 text-success' },
  DRAFT: { icon: GitPullRequestDraft, className: 'bg-muted text-muted-foreground' },
  MERGED: {
    icon: GitMerge,
    className: 'bg-violet-100 text-violet-900 dark:bg-violet-950 dark:text-violet-200',
  },
  CLOSED: { icon: GitPullRequestClosed, className: 'bg-destructive/10 text-destructive' },
};

/** State as icon plus text: colour alone never carries the meaning. */
export function PullRequestStateBadge({
  state,
  isDraft = false,
}: {
  state: PullRequestState;
  isDraft?: boolean;
}) {
  const kind = state === 'OPEN' && isDraft ? 'DRAFT' : state;
  const { icon: Icon, className } = PR_STYLES[kind];
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs font-medium whitespace-nowrap',
        className,
      )}
    >
      <Icon className="size-3.5" aria-hidden="true" />
      {kind === 'DRAFT' ? 'Draft' : PULL_REQUEST_STATE_LABELS[state]}
    </span>
  );
}

const SYNC_STYLES: Record<GithubSyncStatus, string> = {
  IDLE: 'text-muted-foreground',
  QUEUED: 'text-muted-foreground',
  RUNNING: 'text-blue-700 dark:text-blue-300',
  FAILED: 'text-destructive',
  RATE_LIMITED: 'text-orange-700 dark:text-orange-300',
};

export function SyncStatusText({
  status,
  lastSyncedAt,
}: {
  status: GithubSyncStatus;
  lastSyncedAt: string | null;
}) {
  const label =
    status === 'IDLE'
      ? lastSyncedAt
        ? `Synced ${new Date(lastSyncedAt).toLocaleString()}`
        : 'Not synced yet'
      : SYNC_STATUS_LABELS[status];
  return <span className={cn('text-xs', SYNC_STYLES[status])}>{label}</span>;
}

/** Forge issue keys a PR or commit mentions, as links to the issues. */
export function IssueKeyLinks({ keys }: { keys: string[] }) {
  if (keys.length === 0) return null;
  return (
    <span className="flex flex-wrap gap-1">
      {keys.map((key) => (
        <Link
          key={key}
          href={`/projects/${key.slice(0, key.lastIndexOf('-'))}/issues/${key}`}
          className="rounded border px-1.5 font-mono text-xs hover:bg-muted"
        >
          {key}
        </Link>
      ))}
    </span>
  );
}

/** External link to GitHub. Opens a new tab without giving it a handle on this one. */
export function GithubLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="hover:underline">
      {children}
    </a>
  );
}

export const shortSha = (sha: string) => sha.slice(0, 7);
export { commitTitle };
