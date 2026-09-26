import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';

import { SystemStatus } from './system-status';

function renderWithClient() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <SystemStatus />
    </QueryClientProvider>,
  );
}

function mockFetch(status: number, body: unknown) {
  global.fetch = jest.fn().mockResolvedValue({
    ok: status < 400,
    status,
    json: () => Promise.resolve(body),
  });
}

describe('SystemStatus', () => {
  it('lists each dependency as operational when the API is ready', async () => {
    mockFetch(200, { status: 'ok', checks: { redis: { status: 'ok' } } });
    renderWithClient();

    expect(await screen.findByText('Operational')).toBeInTheDocument();
    expect(screen.getByText('redis')).toBeInTheDocument();
    expect(global.fetch).toHaveBeenCalledWith('/api/v1/health/ready', expect.anything());
  });

  it('shows the failing dependency when the API reports 503', async () => {
    mockFetch(503, {
      status: 'error',
      checks: { redis: { status: 'error', message: 'Connection is closed.' } },
    });
    renderWithClient();

    const badge = await screen.findByText('Unavailable');
    expect(badge).toHaveAttribute('title', 'Connection is closed.');
  });

  it('shows an alert when the API cannot be reached', async () => {
    global.fetch = jest.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    renderWithClient();

    expect(await screen.findByRole('alert')).toHaveTextContent('API unreachable');
  });
});
