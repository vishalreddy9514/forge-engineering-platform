import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import NotificationsPage from './page';

const push = jest.fn();
jest.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));

const markRead = jest.fn();
const markAll = jest.fn();
const payload = {
  projectKey: 'PAY',
  issueKey: 'PAY-3',
  issueTitle: 'Refunds fail',
  actorName: 'Sam',
};
const notifications = [
  { id: 'n1', type: 'ISSUE_ASSIGNED', payload, readAt: null, createdAt: '2026-09-26T10:00:00Z' },
  {
    id: 'n2',
    type: 'COMMENT_ADDED',
    payload: { ...payload, issueKey: 'PAY-4' },
    readAt: '2026-09-26T11:00:00Z',
    createdAt: '2026-09-26T09:00:00Z',
  },
];
jest.mock('@/lib/queries/notifications', () => ({
  useNotifications: () => ({
    data: { pages: [{ data: notifications, nextCursor: null }] },
    isPending: false,
    isError: false,
    hasNextPage: false,
  }),
  useUnreadCount: () => ({ data: { count: 1 } }),
  useMarkRead: () => ({ mutate: markRead }),
  useMarkAllRead: () => ({ mutate: markAll, isPending: false }),
}));

describe('NotificationsPage', () => {
  beforeEach(() => {
    push.mockReset();
    markRead.mockReset();
    markAll.mockReset();
  });

  it('describes each notification and marks unread ones', () => {
    render(<NotificationsPage />);
    expect(screen.getByRole('button', { name: /Sam assigned you PAY-3 \(unread\)/ })).toBeVisible();
    expect(screen.getByRole('button', { name: /Sam commented on PAY-4/ })).not.toHaveAccessibleName(
      /unread/,
    );
  });

  it('opening an unread notification marks it read and goes to the issue', async () => {
    render(<NotificationsPage />);
    await userEvent.click(screen.getByRole('button', { name: /assigned you PAY-3/ }));
    expect(markRead).toHaveBeenCalledWith('n1');
    expect(push).toHaveBeenCalledWith('/projects/PAY/issues/PAY-3');

    await userEvent.click(screen.getByRole('button', { name: /commented on PAY-4/ }));
    expect(markRead).toHaveBeenCalledTimes(1); // already read
  });

  it('marks everything read', async () => {
    render(<NotificationsPage />);
    await userEvent.click(screen.getByRole('button', { name: 'Mark all as read' }));
    expect(markAll).toHaveBeenCalled();
  });
});
