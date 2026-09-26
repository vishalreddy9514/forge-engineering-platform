import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { setAccessToken } from '@/lib/api';

import { CreateProjectForm } from './create-project-form';

const push = jest.fn();
jest.mock('next/navigation', () => ({ useRouter: () => ({ push, back: jest.fn() }) }));

function renderForm() {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <CreateProjectForm />
    </QueryClientProvider>,
  );
}

const fetchMock = jest.fn();

describe('CreateProjectForm', () => {
  beforeEach(() => {
    global.fetch = fetchMock;
    fetchMock.mockReset();
    push.mockReset();
    setAccessToken('token');
  });

  it('suggests a key from the name until the key is edited by hand', async () => {
    const user = userEvent.setup();
    renderForm();
    const name = screen.getByLabelText('Project name');
    const key = screen.getByLabelText('Key');

    await user.type(name, 'Payments Platform');
    expect(key).toHaveValue('PP');

    await user.clear(key);
    await user.type(key, 'PAY');
    await user.type(name, ' v2');
    expect(key).toHaveValue('PAY');
  });

  it('creates the project and opens it', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 201,
      json: () =>
        Promise.resolve({
          id: '01920000-0000-7000-8000-000000000001',
          key: 'PAY',
          name: 'Payments',
          description: null,
          archivedAt: null,
          createdAt: '2026-09-26T10:00:00.000Z',
          myRole: 'PROJECT_MANAGER',
          memberCount: 1,
          openIssueCount: 0,
          defaultAssignee: null,
          createdBy: {
            id: '01920000-0000-7000-8000-000000000002',
            displayName: 'Priya',
            email: 'priya@forge.local',
            avatarUrl: null,
          },
          activeSprint: null,
        }),
    });
    const user = userEvent.setup();
    renderForm();
    await user.type(screen.getByLabelText('Project name'), 'Payments');
    await user.clear(screen.getByLabelText('Key'));
    await user.type(screen.getByLabelText('Key'), 'pay');
    await user.click(screen.getByRole('button', { name: 'Create project' }));

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ key: 'PAY', name: 'Payments' });
    await screen.findByRole('button', { name: 'Create project' });
    expect(push).toHaveBeenCalledWith('/projects/PAY');
  });

  it('shows a taken key under the key field', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 409,
      json: () =>
        Promise.resolve({
          type: 'about:blank',
          title: 'Conflict',
          status: 409,
          detail: 'Validation failed',
          errors: [{ path: 'key', message: 'The key PAY is already taken' }],
        }),
    });
    const user = userEvent.setup();
    renderForm();
    await user.type(screen.getByLabelText('Project name'), 'Payments');
    await user.click(screen.getByRole('button', { name: 'Create project' }));

    expect(await screen.findByText('The key PAY is already taken')).toBeInTheDocument();
    expect(screen.getByLabelText('Key')).toHaveAttribute('aria-invalid', 'true');
    expect(push).not.toHaveBeenCalled();
  });
});
