import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ApiError } from '@/lib/api';

import { LoginForm, safeNextPath } from './login-form';

const replace = jest.fn();
let search = new URLSearchParams();
jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace }),
  useSearchParams: () => search,
}));

const login = jest.fn();
jest.mock('./auth-provider', () => ({ useAuth: () => ({ login }) }));

describe('LoginForm', () => {
  beforeEach(() => {
    replace.mockReset();
    login.mockReset();
    search = new URLSearchParams();
  });

  async function submit(email: string, password: string) {
    const user = userEvent.setup();
    if (email) await user.type(screen.getByLabelText('Email'), email);
    if (password) await user.type(screen.getByLabelText('Password'), password);
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
  }

  it('validates before calling the API', async () => {
    render(<LoginForm />);
    await submit('not-an-email', '');

    expect(await screen.findByText('Enter a valid email address')).toBeInTheDocument();
    expect(screen.getByText('Enter your password')).toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toHaveAttribute('aria-invalid', 'true');
    expect(login).not.toHaveBeenCalled();
  });

  it('signs in and goes to the requested page', async () => {
    search = new URLSearchParams('next=/projects/PAY');
    login.mockResolvedValue(undefined);
    render(<LoginForm />);
    await submit('Sam@Forge.local', 'forge-demo-password');

    expect(login).toHaveBeenCalledWith({
      email: 'sam@forge.local',
      password: 'forge-demo-password',
    });
    expect(replace).toHaveBeenCalledWith('/projects/PAY');
  });

  it('shows the server message for bad credentials', async () => {
    login.mockRejectedValue(
      new ApiError(401, {
        type: 'about:blank',
        title: 'Unauthorized',
        status: 401,
        detail: 'Invalid email or password',
      }),
    );
    render(<LoginForm />);
    await submit('sam@forge.local', 'wrong');

    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid email or password');
    expect(replace).not.toHaveBeenCalled();
  });
});

describe('safeNextPath', () => {
  it.each([
    ['/projects/PAY', '/projects/PAY'],
    [null, '/'],
    ['https://evil.example', '/'],
    ['//evil.example/path', '/'],
  ])('%j → %j', (next, expected) => {
    expect(safeNextPath(next)).toBe(expected);
  });
});
