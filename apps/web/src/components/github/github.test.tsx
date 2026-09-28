import type { LinkedRepository, PullRequest } from '@forge/types';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { DevelopmentPanel } from './development-panel';
import { PullRequestStateBadge } from './github-badges';
import { RepositoryCard } from './repository-card';

const pr: PullRequest = {
  id: '0192f3a4-0000-7000-8000-000000000001',
  repository: { id: '0192f3a4-0000-7000-8000-0000000000aa', fullName: 'acme/payments' },
  number: 42,
  title: 'Retry refunds idempotently',
  state: 'OPEN',
  isDraft: false,
  authorLogin: 'mei',
  headRef: 'feature/PAY-3-retries',
  baseRef: 'main',
  htmlUrl: 'https://github.com/acme/payments/pull/42',
  openedAt: '2026-09-26T10:00:00Z',
  mergedAt: null,
  closedAt: null,
  updatedAt: '2026-09-26T10:00:00Z',
  issueKeys: ['PAY-3'],
};

let development: unknown = { data: { pullRequests: [pr], commits: [] }, isPending: false };
jest.mock('@/lib/queries/github', () => ({
  useIssueDevelopment: () => development,
}));

describe('PullRequestStateBadge', () => {
  it.each([
    ['OPEN', false, 'Open'],
    ['OPEN', true, 'Draft'],
    ['MERGED', false, 'Merged'],
    ['CLOSED', false, 'Closed'],
  ] as const)('shows %s (draft: %s) as text, not only colour', (state, isDraft, label) => {
    render(<PullRequestStateBadge state={state} isDraft={isDraft} />);
    expect(screen.getByText(label)).toBeInTheDocument();
  });
});

describe('DevelopmentPanel', () => {
  it('lists linked PRs and commits as external links that cannot reach back', () => {
    development = {
      isPending: false,
      isError: false,
      data: {
        pullRequests: [pr],
        commits: [
          {
            id: '0192f3a4-0000-7000-8000-000000000002',
            repository: pr.repository,
            sha: '2d8f39ad0f296c0247f7edffc2cf77973039b8b8',
            message: 'PAY-3: add retry budget\n\nLonger explanation',
            authorLogin: null,
            authorName: 'Mei Tanaka',
            committedAt: '2026-09-26T11:00:00Z',
            htmlUrl: 'https://github.com/acme/payments/commit/2d8f39a',
            issueKeys: ['PAY-3'],
          },
        ],
      },
    };
    render(<DevelopmentPanel issueId="i" issueKey="PAY-3" />);
    const prLink = screen.getByRole('link', { name: /acme\/payments#42 Retry refunds/ });
    expect(prLink).toHaveAttribute('href', pr.htmlUrl);
    expect(prLink).toHaveAttribute('target', '_blank');
    expect(prLink).toHaveAttribute('rel', 'noopener noreferrer');
    // A commit shows its short SHA and first line only.
    expect(
      screen.getByRole('link', { name: '2d8f39a PAY-3: add retry budget' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Mei Tanaka/)).toBeInTheDocument();
  });

  it('explains how to link work when nothing mentions the issue', () => {
    development = {
      isPending: false,
      isError: false,
      data: { pullRequests: [], commits: [] },
    };
    render(<DevelopmentPanel issueId="i" issueKey="PAY-3" />);
    expect(screen.getByText(/No pull requests or commits mention PAY-3 yet/)).toBeInTheDocument();
  });
});

describe('RepositoryCard', () => {
  const repo: LinkedRepository = {
    id: '0192f3a4-0000-7000-8000-0000000000aa',
    fullName: 'acme/payments',
    htmlUrl: 'https://github.com/acme/payments',
    isPrivate: true,
    defaultBranch: 'main',
    linkedAt: '2026-09-26T09:00:00Z',
    syncStatus: 'IDLE',
    lastSyncedAt: '2026-09-26T10:00:00Z',
    lastSyncError: null,
    counts: { openPullRequests: 2, commits: 57, openIssues: 1 },
    contributors: [{ login: 'mei', avatarUrl: null, contributions: 40 }],
  };

  it('shows counts, contributors and actions for those allowed', async () => {
    const onSync = jest.fn();
    const onUnlink = jest.fn();
    render(
      <RepositoryCard
        repository={repo}
        canSync
        canUnlink
        syncing={false}
        onSync={onSync}
        onUnlink={onUnlink}
      />,
    );
    expect(screen.getByLabelText('Private repository')).toBeInTheDocument();
    const counts = screen.getByText('Commits synced').closest('div');
    expect(within(counts as HTMLElement).getByText('57')).toBeInTheDocument();
    expect(screen.getByText(/mei/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Sync now' }));
    await userEvent.click(screen.getByRole('button', { name: 'Unlink acme/payments' }));
    expect(onSync).toHaveBeenCalled();
    expect(onUnlink).toHaveBeenCalled();
  });

  it('disables syncing while a sync is running and shows why a sync failed', () => {
    const { rerender } = render(
      <RepositoryCard
        repository={{ ...repo, syncStatus: 'RUNNING' }}
        canSync
        canUnlink={false}
        syncing={false}
        onSync={jest.fn()}
        onUnlink={jest.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: 'Sync now' })).toBeDisabled();
    expect(screen.getByText('Syncing')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Unlink/ })).not.toBeInTheDocument();

    rerender(
      <RepositoryCard
        repository={{ ...repo, syncStatus: 'FAILED', lastSyncError: 'GitHub 404: Not Found' }}
        canSync={false}
        canUnlink={false}
        syncing={false}
        onSync={jest.fn()}
        onUnlink={jest.fn()}
      />,
    );
    expect(screen.getByText('Sync failed')).toBeInTheDocument();
    expect(screen.getByText('GitHub 404: Not Found')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sync now' })).not.toBeInTheDocument();
  });
});
