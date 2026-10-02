import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen } from '@testing-library/react';

import { DUPLICATE_DEBOUNCE_MS, DuplicateHints } from './duplicate-hints';

const relatedToDraft = jest.fn();
jest.mock('@/lib/queries/search', () => ({
  relatedToDraft: (...args: unknown[]) => relatedToDraft(...args) as unknown,
}));

const duplicate = {
  id: '01900000-0000-7000-8000-000000000001',
  key: 'PAY-1',
  title: 'Stripe webhook retries double-charge',
  status: 'DONE',
  type: 'BUG',
  score: 0.71,
};

function renderHints(text: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = (value: string) => (
    <QueryClientProvider client={client}>
      <DuplicateHints projectId="p1" projectKey="PAY" text={value} />
    </QueryClientProvider>
  );
  const result = render(view(text));
  return {
    ...result,
    type: (value: string) => {
      result.rerender(view(value));
    },
  };
}

describe('DuplicateHints', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    relatedToDraft.mockReset();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('asks once typing pauses, then lists likely duplicates', async () => {
    relatedToDraft.mockResolvedValue({ data: [duplicate] });
    const { type } = renderHints('Customers');
    type('Customers charged twice');
    type('Customers charged twice by Stripe');
    expect(relatedToDraft).not.toHaveBeenCalled();

    await act(async () => {
      jest.advanceTimersByTime(DUPLICATE_DEBOUNCE_MS);
      await Promise.resolve();
    });

    expect(relatedToDraft).toHaveBeenCalledTimes(1);
    expect(relatedToDraft).toHaveBeenCalledWith(
      'p1',
      'Customers charged twice by Stripe',
      expect.anything(),
    );
    expect(await screen.findByText('Possible duplicates')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /PAY-1/ })).toHaveAttribute(
      'href',
      '/projects/PAY/issues/PAY-1',
    );
  });

  it('stays silent for short text and when nothing is similar', async () => {
    relatedToDraft.mockResolvedValue({ data: [] });
    const { type, container } = renderHints('Too short');
    await act(async () => {
      jest.advanceTimersByTime(DUPLICATE_DEBOUNCE_MS);
      await Promise.resolve();
    });
    expect(relatedToDraft).not.toHaveBeenCalled();

    type('A long enough description of a new problem');
    await act(async () => {
      jest.advanceTimersByTime(DUPLICATE_DEBOUNCE_MS);
      await Promise.resolve();
    });
    expect(relatedToDraft).toHaveBeenCalledTimes(1);
    expect(container).toBeEmptyDOMElement();
  });
});
