import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { AuthProvider, useAuth } from './auth-provider';

const replace = jest.fn();
jest.mock('next/navigation', () => ({ useRouter: () => ({ replace }) }));
jest.mock('@/lib/auth-api', () => ({
  authApi: { logout: jest.fn().mockResolvedValue(undefined) },
}));
jest.mock('@/lib/api', () => ({
  refreshSession: jest.fn().mockResolvedValue(null),
  setSessionExpiredHandler: jest.fn(),
}));

function SignOut() {
  const { logout } = useAuth();
  return (
    <button type="button" onClick={() => void logout()}>
      Sign out
    </button>
  );
}

describe('AuthProvider', () => {
  it('forgets everything fetched for the person who signs out (ASVS 8.2.3)', async () => {
    const client = new QueryClient();
    client.setQueryData(['projects'], [{ key: 'PAY', name: 'Payments' }]);
    render(
      <QueryClientProvider client={client}>
        <AuthProvider>
          <SignOut />
        </AuthProvider>
      </QueryClientProvider>,
    );
    await act(() => Promise.resolve());

    await userEvent.setup().click(screen.getByRole('button', { name: 'Sign out' }));

    expect(client.getQueryData(['projects'])).toBeUndefined();
    expect(replace).toHaveBeenCalledWith('/login');
  });
});
