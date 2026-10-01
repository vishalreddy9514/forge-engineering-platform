import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { partialTitle } from './draft-assistant';
import { SummaryPanel } from './summary-panel';

let available = true;
let summary: unknown = null;
let job: unknown = undefined;
const mutateAsync = jest.fn();
jest.mock('@/lib/queries/ai', () => ({
  useAiStatus: () => ({ data: { available, budget: { used: 0, limit: 1 } } }),
  useIssueSummary: () => ({ data: summary, isPending: false, isError: false }),
  useRequestSummary: () => ({ mutateAsync, isPending: false }),
  useAiJob: (jobId: string | null) => ({ data: jobId ? job : undefined }),
}));

const stored = {
  summary: {
    tldr: 'Webhook retries charge customers twice.',
    keyDecisions: ['Store Stripe event IDs.'],
    openQuestions: [],
    nextSteps: ['Add a regression test.'],
  },
  generatedAt: '2026-09-28T09:00:00Z',
  model: 'gpt-4.1-mini',
  promptVersion: 'thread_summary@1',
  stale: false,
};

describe('partialTitle', () => {
  it.each([
    ['', null],
    ['{"tit', null],
    ['{"title": "Double ch', 'Double ch'],
    ['{"title": "Say \\"hi\\"", "desc', 'Say "hi"'],
    ['{"title": "Cut \\', 'Cut '], // a half-written escape is left out
  ])('reads %j as %j', (input, expected) => {
    expect(partialTitle(input)).toBe(expected);
  });
});

describe('SummaryPanel', () => {
  beforeEach(() => {
    available = true;
    summary = null;
    job = undefined;
    mutateAsync.mockReset();
  });

  it('shows a summary with its sections, labelled as AI-generated', () => {
    summary = stored;
    render(<SummaryPanel issueId="i" canRequest />);
    expect(screen.getByText('Webhook retries charge customers twice.')).toBeInTheDocument();
    expect(screen.getByText('Store Stripe event IDs.')).toBeInTheDocument();
    expect(screen.queryByText('Open questions')).not.toBeInTheDocument(); // empty list hidden
    expect(screen.getByText(/AI-generated from the thread/)).toBeInTheDocument();
    // Up to date: nothing to refresh.
    expect(screen.queryByRole('button', { name: /summary/i })).not.toBeInTheDocument();
  });

  it('offers an update when the thread changed since the summary', () => {
    summary = { ...stored, stale: true };
    render(<SummaryPanel issueId="i" canRequest />);
    expect(screen.getByText(/Out of date/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Update summary' })).toBeInTheDocument();
  });

  it('queues a job and reports progress, then its failure', async () => {
    mutateAsync.mockResolvedValue({ status: 'queued', job: { id: 'job-1' }, statusUrl: '' });
    job = { id: 'job-1', status: 'RUNNING', error: null };
    const { rerender } = render(<SummaryPanel issueId="i" canRequest />);
    await userEvent.click(screen.getByRole('button', { name: 'Summarise thread' }));
    expect(await screen.findByText(/Summarising the thread/)).toBeInTheDocument();

    job = {
      id: 'job-1',
      status: 'FAILED',
      error: 'The summary could not be made. Please try again.',
    };
    rerender(<SummaryPanel issueId="i" canRequest />);
    expect(screen.getByRole('alert')).toHaveTextContent('The summary could not be made.');
  });

  it('hides AI actions when the assistant is unavailable or not allowed', () => {
    available = false;
    const { rerender } = render(<SummaryPanel issueId="i" canRequest />);
    expect(screen.getByText(/The AI assistant is unavailable right now/)).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    available = true;
    rerender(<SummaryPanel issueId="i" canRequest={false} />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
