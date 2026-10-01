import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ApiError } from '@/lib/api';

import { issueDetail } from '../../../test-stubs/issue-fixtures';

import { CreateIssueDialog } from './create-issue-dialog';

const push = jest.fn();
jest.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));

jest.mock('@/components/projects/project-context', () => ({
  useCurrentProject: () => ({ id: 'project-id', key: 'PAY', name: 'Payments' }),
  useCan: () => true,
}));

let aiAvailable = false;
const streamDraft = jest.fn();
jest.mock('@/lib/queries/ai', () => ({
  useAiStatus: () => ({ data: { available: aiAvailable, budget: { used: 0, limit: 1 } } }),
  streamDraft: (...args: unknown[]) => streamDraft(...args) as unknown,
}));
jest.mock('@/lib/queries/projects', () => ({
  useLabels: () => ({
    data: [
      { id: '0192f3a4-0000-7000-8000-00000000b001', name: 'bug', color: '#d73a4a' },
      { id: '0192f3a4-0000-7000-8000-00000000b002', name: 'payments', color: '#1d76db' },
    ],
  }),
}));

const mutateAsync = jest.fn();
jest.mock('@/lib/queries/issues', () => ({ useCreateIssue: () => ({ mutateAsync }) }));

async function openDialog() {
  const user = userEvent.setup();
  render(<CreateIssueDialog />);
  await user.click(screen.getByRole('button', { name: 'New issue' }));
  return user;
}

describe('CreateIssueDialog', () => {
  beforeEach(() => {
    push.mockReset();
    mutateAsync.mockReset();
    streamDraft.mockReset();
    aiAvailable = false;
  });

  it('requires a title before calling the API', async () => {
    const user = await openDialog();
    await user.click(screen.getByRole('button', { name: 'Create issue' }));
    expect(await screen.findByText('Enter a title')).toBeInTheDocument();
    expect(mutateAsync).not.toHaveBeenCalled();
  });

  it('creates the issue and opens it', async () => {
    mutateAsync.mockResolvedValue(issueDetail({ key: 'PAY-7' }));
    const user = await openDialog();
    await user.type(screen.getByLabelText('Title'), '  Refunds fail for AMEX  ');
    await user.selectOptions(screen.getByLabelText('Type'), 'BUG');
    await user.selectOptions(screen.getByLabelText('Status'), 'TODO');
    await user.click(screen.getByRole('button', { name: 'Create issue' }));

    expect(mutateAsync).toHaveBeenCalledWith({
      title: 'Refunds fail for AMEX',
      description: undefined,
      type: 'BUG',
      priority: 'MEDIUM',
      status: 'TODO',
      labelIds: [],
    });
    expect(push).toHaveBeenCalledWith('/projects/PAY/issues/PAY-7');
  });

  it('shows server field errors under the matching input', async () => {
    mutateAsync.mockRejectedValue(
      new ApiError(400, {
        type: 'about:blank',
        title: 'Bad Request',
        status: 400,
        detail: 'Validation failed',
        errors: [{ path: 'title', message: 'Title is not allowed' }],
      }),
    );
    const user = await openDialog();
    await user.type(screen.getByLabelText('Title'), 'Something');
    await user.click(screen.getByRole('button', { name: 'Create issue' }));

    expect(await screen.findByText('Title is not allowed')).toBeInTheDocument();
    expect(push).not.toHaveBeenCalled();
  });

  it('offers no AI drafting while the AI service is unavailable', async () => {
    await openDialog();
    expect(screen.queryByRole('button', { name: 'Draft with AI' })).not.toBeInTheDocument();
  });

  it('fills the form from an AI draft, which the person then creates', async () => {
    aiAvailable = true;
    streamDraft.mockImplementation(
      (_projectId: string, _text: string, onText: (t: string) => void) => {
        onText('{"title": "Double charges on web');
        return Promise.resolve({
          draft: {
            title: 'Double charges on webhook retry',
            description: 'Stripe retries charge twice.',
            acceptanceCriteria: ['Given a retry, when it arrives, then no second charge'],
            type: 'BUG',
            priority: 'CRITICAL',
            priorityRationale: 'Money is lost now.',
            labels: ['bug'],
            technicalArea: 'payments API',
          },
          droppedLabels: ['invented'],
        });
      },
    );
    mutateAsync.mockResolvedValue(issueDetail({ key: 'PAY-9' }));
    const user = await openDialog();

    await user.click(screen.getByRole('button', { name: 'Draft with AI' }));
    await user.type(
      screen.getByLabelText('Describe it in your own words'),
      'customers get charged twice when stripe retries',
    );
    await user.click(screen.getByRole('button', { name: 'Generate draft' }));

    expect(await screen.findByDisplayValue('Double charges on webhook retry')).toBeInTheDocument();
    expect(screen.getByLabelText('Type')).toHaveValue('BUG');
    expect(screen.getByLabelText('Priority')).toHaveValue('CRITICAL');
    expect(
      screen.getByText(/Ignored labels this project does not have: invented/),
    ).toBeInTheDocument();
    expect(streamDraft).toHaveBeenCalledWith(
      'project-id',
      'customers get charged twice when stripe retries',
      expect.any(Function),
      expect.any(AbortSignal),
    );
    // Nothing is created until the person presses Create.
    expect(mutateAsync).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Create issue' }));
    await waitFor(() => {
      expect(mutateAsync).toHaveBeenCalled();
    });
    expect(mutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Double charges on webhook retry',
        description: expect.stringContaining('## Acceptance criteria') as unknown,
        type: 'BUG',
        priority: 'CRITICAL',
        labelIds: ['0192f3a4-0000-7000-8000-00000000b001'],
      }),
    );
  });

  it('shows the reason when a draft fails', async () => {
    aiAvailable = true;
    streamDraft.mockRejectedValue(new Error('The AI provider is busy or unreachable.'));
    const user = await openDialog();
    await user.click(screen.getByRole('button', { name: 'Draft with AI' }));
    await user.type(
      screen.getByLabelText('Describe it in your own words'),
      'checkout crashes on safari',
    );
    await user.click(screen.getByRole('button', { name: 'Generate draft' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The AI provider is busy');
  });
});
