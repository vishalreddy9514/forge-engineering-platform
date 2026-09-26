import { render, screen } from '@testing-library/react';

import { NotificationBell } from './notification-bell';

let count: number | undefined;
jest.mock('@/lib/queries/notifications', () => ({
  useUnreadCount: () => ({ data: count === undefined ? undefined : { count } }),
}));

describe('NotificationBell', () => {
  it('announces the unread count and shows a badge', () => {
    count = 3;
    render(<NotificationBell active={false} />);
    expect(screen.getByRole('link', { name: 'Notifications, 3 unread' })).toHaveAttribute(
      'href',
      '/notifications',
    );
    expect(screen.getByText('3')).toBeInTheDocument();
  });

  it('caps the badge and hides it when there is nothing unread', () => {
    count = 250;
    const { rerender } = render(<NotificationBell active={false} />);
    expect(screen.getByText('99+')).toBeInTheDocument();
    count = 0;
    rerender(<NotificationBell active />);
    expect(screen.getByRole('link', { name: 'Notifications' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(screen.queryByText('0')).not.toBeInTheDocument();
  });
});
