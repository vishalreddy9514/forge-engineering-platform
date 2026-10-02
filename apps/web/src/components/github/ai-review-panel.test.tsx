import type { PullRequestReview } from '@forge/types';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { AiReviewPanel, groupByFile } from './ai-review-panel';

let available = true;
let review: PullRequestReview | null = null;
let job: unknown = undefined;
const mutateAsync = jest.fn();
jest.mock('@/lib/queries/ai', () => ({
  useAiStatus: () => ({ data: { available, budget: { used: 0, limit: 1 } } }),
}));
jest.mock('@/lib/queries/reviews', () => ({
  useReview: () => ({ data: review, isPending: false, isError: false }),
  useRequestReview: () => ({ mutateAsync, isPending: false }),
  useReviewJob: (jobId: string | null) => ({ data: jobId ? job : undefined }),
}));

const stored: PullRequestReview = {
  id: '01900000-0000-7000-8000-000000000001',
  headSha: 'a'.repeat(40),
  summary: 'Adds a user lookup. One critical issue.',
  findings: [
    {
      file: 'app/db.py',
      line: 42,
      severity: 'critical',
      category: 'security',
      explanation: 'SQL is concatenated.',
      suggestion: 'Use a parameterised query.',
    },
    {
      file: 'app/db.py',
      line: 13,
      severity: 'major',
      category: 'bug',
      explanation: 'The error is swallowed.',
      suggestion: '',
    },
    {
      file: 'web/a.ts',
      line: null,
      severity: 'nit',
      category: 'style',
      explanation: 'Long file.',
      suggestion: '',
    },
  ],
  missingTests: [{ description: 'Test the lookup.', file: 'app/db.py' }],
  files: [{ path: 'app/db.py', status: 'reviewed', summary: 'Adds a query.', findings: 2 }],
  skippedFiles: [{ path: 'pnpm-lock.yaml', reason: 'lockfile' }],
  model: 'gpt-4.1-mini',
  promptVersion: 'pr_review@1',
  createdAt: '2026-10-01T10:00:00Z',
  stale: false,
};

const renderPanel = (canRequest = true) =>
  render(
    <AiReviewPanel
      projectId="p"
      pullRequestId="pr"
      filesUrl="https://github.com/acme/pay/pull/41/files"
      canRequest={canRequest}
    />,
  );

describe('AiReviewPanel', () => {
  beforeEach(() => {
    available = true;
    review = null;
    job = undefined;
    mutateAsync.mockReset();
  });

  it('always shows the disclaimer, and groups findings by file, most severe first', () => {
    review = stored;
    renderPanel();

    expect(
      screen.getByText('AI-generated suggestions. This does not replace human code review.'),
    ).toBeInTheDocument();
    const db = screen.getByRole('region', { name: 'Findings in app/db.py' });
    const items = within(db).getAllByRole('listitem');
    expect(items[0]).toHaveTextContent('critical');
    expect(items[0]).toHaveTextContent('line 42');
    expect(items[0]).toHaveTextContent('Suggestion: Use a parameterised query.');
    expect(
      within(screen.getByRole('region', { name: 'Findings in web/a.ts' })).getByText('whole file'),
    ).toBeInTheDocument();
    expect(screen.getByText('Test the lookup.')).toBeInTheDocument();
    expect(screen.getByText(/1 file\(s\) reviewed, 1 skipped/)).toBeInTheDocument();
    // An up-to-date review needs no new request.
    expect(screen.queryByRole('button', { name: /review/i })).not.toBeInTheDocument();
  });

  it('copies the review as Markdown for a person to post', async () => {
    review = stored;
    const writeText = jest.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    renderPanel();

    await userEvent.click(screen.getByRole('button', { name: 'Copy as Markdown' }));

    expect(writeText).toHaveBeenCalledWith(
      expect.stringContaining('- **critical** (security) `app/db.py:42`'),
    );
    expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument();
  });

  it('offers a new review when commits were pushed since', () => {
    review = { ...stored, stale: true };
    renderPanel();
    expect(screen.getByText(/New commits were pushed after this review/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Review latest commit' })).toBeInTheDocument();
  });

  it('queues a review and shows that it is running', async () => {
    mutateAsync.mockResolvedValue({ status: 'queued', job: { id: 'j1', status: 'QUEUED' } });
    job = { id: 'j1', status: 'RUNNING' };
    renderPanel();

    await userEvent.click(screen.getByRole('button', { name: 'Review with AI' }));

    expect(await screen.findByText(/Reviewing the changes/)).toBeInTheDocument();
  });

  it('shows the reason when a review cannot be requested', async () => {
    mutateAsync.mockRejectedValue(new Error('You have used today’s AI allowance.'));
    renderPanel();
    await userEvent.click(screen.getByRole('button', { name: 'Review with AI' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('AI allowance');
  });

  it('hides the action from viewers and while the AI is unavailable', () => {
    renderPanel(false);
    expect(screen.queryByRole('button', { name: 'Review with AI' })).not.toBeInTheDocument();
    available = false;
    renderPanel();
    expect(screen.getAllByText(/AI review is unavailable right now/)).not.toHaveLength(0);
  });
});

describe('groupByFile', () => {
  it('keeps the ranking within and across files', () => {
    expect(groupByFile(stored.findings).map(([file, f]) => [file, f.length])).toEqual([
      ['app/db.py', 2],
      ['web/a.ts', 1],
    ]);
  });
});
