import { describeNotification, ListNotificationsQuery } from './notifications';

const payload = { projectKey: 'PAY', issueKey: 'PAY-3', issueTitle: 'Refunds', actorName: 'Sam' };

describe('notifications', () => {
  it('describes each kind in one line', () => {
    expect(describeNotification({ type: 'ISSUE_ASSIGNED', payload })).toBe(
      'Sam assigned you PAY-3',
    );
    expect(describeNotification({ type: 'COMMENT_ADDED', payload })).toBe('Sam commented on PAY-3');
  });

  it('parses the unread filter from the query string', () => {
    expect(ListNotificationsQuery.parse({ unread: 'true' })).toMatchObject({
      unread: true,
      limit: 25,
    });
    expect(ListNotificationsQuery.parse({}).unread).toBeUndefined();
    expect(ListNotificationsQuery.safeParse({ unread: 'yes' }).success).toBe(false);
  });
});
