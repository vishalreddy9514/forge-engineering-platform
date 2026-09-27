import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ApiError } from '@/lib/api';

import { issueDetail } from '../../../test-stubs/issue-fixtures';

import { CreateIssueDialog } from './create-issue-dialog';

const push = jest.fn();
jest.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));

jest.mock('@/components/projects/project-context', () => ({
  useCurrentProject: () => ({ id: 'project-id', key: 'PAY', name: 'Payments' }),
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
});
