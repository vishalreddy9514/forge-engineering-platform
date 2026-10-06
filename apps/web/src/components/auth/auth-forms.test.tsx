import { render } from '@testing-library/react';
import type { ComponentType } from 'react';

import { ForgotPasswordForm } from './forgot-password-form';
import { LoginForm } from './login-form';
import { RegisterForm } from './register-form';
import { ResetPasswordForm } from './reset-password-form';

jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace: jest.fn(), push: jest.fn() }),
  useSearchParams: () => new URLSearchParams('token=t'),
}));
jest.mock('./auth-provider', () => ({
  useAuth: () => ({ login: jest.fn(), register: jest.fn() }),
}));
jest.mock('@/lib/auth-api', () => ({ authApi: {} }));

// A form submitted before the page hydrates is sent by the browser itself. With the default
// GET, the email and password would land in the URL, and so in access logs and history.
describe.each<[string, ComponentType]>([
  ['sign in', LoginForm],
  ['register', RegisterForm],
  ['forgot password', ForgotPasswordForm],
  ['reset password', ResetPasswordForm],
])('the %s form', (_name, Form) => {
  it('posts, so its fields never reach the URL', () => {
    const { container } = render(<Form />);
    expect(container.querySelector('form')).toHaveAttribute('method', 'post');
  });
});
