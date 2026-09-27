import { z } from 'zod';

import { CursorPaginationQuery } from './pagination';

/**
 * GitHub integration (FR-6, ADR-0008). Forge reads repositories through a GitHub App
 * installation and never writes back; these are the shapes the web app sees.
 */

export const PullRequestState = z.enum(['OPEN', 'CLOSED', 'MERGED']);
export type PullRequestState = z.infer<typeof PullRequestState>;

export const GithubIssueState = z.enum(['OPEN', 'CLOSED']);
export type GithubIssueState = z.infer<typeof GithubIssueState>;

/** Where a repository's last sync stands. RATE_LIMITED jobs resume on their own after the reset. */
export const GithubSyncStatus = z.enum(['IDLE', 'QUEUED', 'RUNNING', 'FAILED', 'RATE_LIMITED']);
export type GithubSyncStatus = z.infer<typeof GithubSyncStatus>;

export const PULL_REQUEST_STATE_LABELS: Record<PullRequestState, string> = {
  OPEN: 'Open',
  CLOSED: 'Closed',
  MERGED: 'Merged',
};

export const SYNC_STATUS_LABELS: Record<GithubSyncStatus, string> = {
  IDLE: 'Up to date',
  QUEUED: 'Queued',
  RUNNING: 'Syncing',
  FAILED: 'Sync failed',
  RATE_LIMITED: 'Waiting for GitHub rate limit',
};

/** Whether the server has a GitHub App configured, and where to install it. */
export const GithubStatus = z.object({
  configured: z.boolean(),
  installUrl: z.string().nullable(),
});
export type GithubStatus = z.infer<typeof GithubStatus>;

export const GithubRepository = z.object({
  id: z.uuid(),
  fullName: z.string(),
  htmlUrl: z.string(),
  isPrivate: z.boolean(),
  defaultBranch: z.string(),
});
export type GithubRepository = z.infer<typeof GithubRepository>;

export const GithubInstallation = z.object({
  id: z.uuid(),
  installationId: z.number().int(),
  accountLogin: z.string(),
  accountType: z.enum(['USER', 'ORGANIZATION']),
  suspended: z.boolean(),
  createdAt: z.string(),
  repositories: z.array(GithubRepository),
});
export type GithubInstallation = z.infer<typeof GithubInstallation>;

/**
 * Sent by the web app after GitHub redirects back from an installation. The API confirms the
 * installation with GitHub before storing it, so an invented ID is rejected.
 */
export const ClaimInstallationRequest = z.object({
  installationId: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});
export type ClaimInstallationRequest = z.infer<typeof ClaimInstallationRequest>;

export const GithubContributor = z.object({
  login: z.string(),
  avatarUrl: z.string().nullable(),
  contributions: z.number().int(),
});
export type GithubContributor = z.infer<typeof GithubContributor>;

/** A repository as linked to one project, with its sync state and headline numbers. */
export const LinkedRepository = GithubRepository.extend({
  linkedAt: z.string(),
  syncStatus: GithubSyncStatus,
  lastSyncedAt: z.string().nullable(),
  lastSyncError: z.string().nullable(),
  counts: z.object({
    openPullRequests: z.number().int(),
    commits: z.number().int(),
    openIssues: z.number().int(),
  }),
  contributors: z.array(GithubContributor),
});
export type LinkedRepository = z.infer<typeof LinkedRepository>;

export const LinkRepositoryRequest = z.object({ repositoryId: z.uuid() });
export type LinkRepositoryRequest = z.infer<typeof LinkRepositoryRequest>;

const RepositoryRef = z.object({ id: z.uuid(), fullName: z.string() });

export const PullRequest = z.object({
  id: z.uuid(),
  repository: RepositoryRef,
  number: z.number().int(),
  title: z.string(),
  state: PullRequestState,
  isDraft: z.boolean(),
  authorLogin: z.string().nullable(),
  headRef: z.string(),
  baseRef: z.string(),
  htmlUrl: z.string(),
  openedAt: z.string(),
  mergedAt: z.string().nullable(),
  closedAt: z.string().nullable(),
  updatedAt: z.string(),
  /** Forge issues this PR mentions, e.g. ["PAY-12"]. */
  issueKeys: z.array(z.string()),
});
export type PullRequest = z.infer<typeof PullRequest>;

export const Commit = z.object({
  id: z.uuid(),
  repository: RepositoryRef,
  sha: z.string(),
  message: z.string(),
  authorLogin: z.string().nullable(),
  authorName: z.string().nullable(),
  committedAt: z.string(),
  htmlUrl: z.string(),
  issueKeys: z.array(z.string()),
});
export type Commit = z.infer<typeof Commit>;

export const GithubIssue = z.object({
  id: z.uuid(),
  repository: RepositoryRef,
  number: z.number().int(),
  title: z.string(),
  state: GithubIssueState,
  authorLogin: z.string().nullable(),
  labels: z.array(z.string()),
  commentsCount: z.number().int(),
  htmlUrl: z.string(),
  openedAt: z.string(),
  closedAt: z.string().nullable(),
});
export type GithubIssue = z.infer<typeof GithubIssue>;

const RepositoryFilter = { repositoryId: z.uuid().optional() };

export const ListPullRequestsQuery = CursorPaginationQuery.extend({
  ...RepositoryFilter,
  state: PullRequestState.optional(),
});
export type ListPullRequestsQuery = z.infer<typeof ListPullRequestsQuery>;

export const ListCommitsQuery = CursorPaginationQuery.extend(RepositoryFilter);
export type ListCommitsQuery = z.infer<typeof ListCommitsQuery>;

export const ListGithubIssuesQuery = CursorPaginationQuery.extend({
  ...RepositoryFilter,
  state: GithubIssueState.optional(),
});
export type ListGithubIssuesQuery = z.infer<typeof ListGithubIssuesQuery>;

/** The "Development" panel on an issue: PRs and commits that mention it. */
export const IssueDevelopment = z.object({
  pullRequests: z.array(PullRequest),
  commits: z.array(Commit),
});
export type IssueDevelopment = z.infer<typeof IssueDevelopment>;

export const SyncRequested = z.object({ repositoryId: z.uuid(), syncStatus: GithubSyncStatus });
export type SyncRequested = z.infer<typeof SyncRequested>;

/**
 * Issue-key mentions such as "PAY-123" (FR-6.4). A key is 2–10 upper-case letters or digits
 * starting with a letter (the project-key rule), then a hyphen and a number. Surrounding
 * characters must not continue a word, so "PAY-12" is not found inside "XPAY-12" or "PAY-12a",
 * and "pay-12" is not a key, while branch names like "feature/PAY-12-retry" do mention PAY-12. Returns unique keys in order of first mention.
 */
const ISSUE_KEY_MENTION = /(?<![A-Za-z0-9_])[A-Z][A-Z0-9]{1,9}-[1-9][0-9]{0,8}(?![A-Za-z0-9_])/g;

export function findIssueKeys(text: string): string[] {
  return [...new Set(text.match(ISSUE_KEY_MENTION))];
}

/** First line of a commit message, for lists. */
export function commitTitle(message: string): string {
  return message.split('\n', 1)[0] ?? '';
}
