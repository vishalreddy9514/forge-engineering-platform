import { render, screen, waitFor } from '@testing-library/react';

import GithubPage from './page';

let isAdmin = true;
jest.mock('@/components/auth/auth-provider', () => ({
  useAuth: () => ({ state: { status: 'authenticated', user: { isAdmin } } }),
}));

const replace = jest.fn();
let search = new URLSearchParams();
jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace }),
  useSearchParams: () => search,
}));

const claim = jest.fn();
jest.mock('@/lib/queries/github', () => ({
  useGithubStatus: () => ({
    isPending: false,
    data: { configured: true, installUrl: 'https://github.com/apps/forge/installations/new' },
  }),
  useInstallations: () => ({
    isPending: false,
    isError: false,
    data: [
      {
        id: 'i1',
        installationId: 7,
        accountLogin: 'acme',
        accountType: 'ORGANIZATION',
        suspended: false,
        createdAt: '2026-09-26T00:00:00Z',
        repositories: [
          {
            id: 'r1',
            fullName: 'acme/payments',
            htmlUrl: '',
            isPrivate: true,
            defaultBranch: 'main',
          },
        ],
      },
    ],
  }),
  useClaimInstallation: () => ({ mutateAsync: claim }),
}));

describe('GitHub connections page', () => {
  beforeEach(() => {
    isAdmin = true;
    search = new URLSearchParams();
    claim.mockReset().mockResolvedValue({ accountLogin: 'acme' });
    replace.mockReset();
  });

  it('offers the install link and lists connected accounts to administrators', () => {
    render(<GithubPage />);
    expect(screen.getByRole('link', { name: 'Install on GitHub' })).toHaveAttribute(
      'href',
      'https://github.com/apps/forge/installations/new',
    );
    expect(screen.getByRole('heading', { name: 'acme' })).toBeInTheDocument();
    expect(screen.getByText('acme/payments')).toBeInTheDocument();
    expect(claim).not.toHaveBeenCalled();
  });

  it('records the installation GitHub redirected back with, once, then clears the URL', async () => {
    search = new URLSearchParams({ installation_id: '12345', setup_action: 'install' });
    const { rerender } = render(<GithubPage />);
    rerender(<GithubPage />);
    await waitFor(() => {
      expect(screen.getByText(/Connected acme/)).toBeInTheDocument();
    });
    expect(claim).toHaveBeenCalledTimes(1);
    expect(claim).toHaveBeenCalledWith(12345);
    expect(replace).toHaveBeenCalledWith('/github');
  });

  it('never claims for people who are not administrators', () => {
    isAdmin = false;
    search = new URLSearchParams({ installation_id: '12345', setup_action: 'install' });
    render(<GithubPage />);
    expect(claim).not.toHaveBeenCalled();
    expect(screen.queryByRole('link', { name: 'Install on GitHub' })).not.toBeInTheDocument();
    expect(screen.getByText(/an administrator will see it here/)).toBeInTheDocument();
  });
});
