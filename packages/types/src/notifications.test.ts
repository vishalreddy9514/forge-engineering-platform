import {
  describeNotification,
  ListNotificationsQuery,
  Notification,
  notificationHref,
} from './notifications';

const issuePayload = {
  projectKey: 'PAY',
  issueKey: 'PAY-3',
  issueTitle: 'Refunds',
  actorName: 'Sam',
};
const sprintPayload = {
  projectKey: 'PAY',
  sprintId: 's1',
  sprintName: 'PAY Sprint 2',
  actorName: 'Priya',
};
const base = {
  id: '0192f3a4-0000-7000-8000-000000000001',
  readAt: null,
  createdAt: '2026-09-27T10:00:00Z',
};

describe('notifications', () => {
  it('describes each kind in one line and links to the right page', () => {
    const assigned = Notification.parse({ ...base, type: 'ISSUE_ASSIGNED', payload: issuePayload });
    expect(describeNotification(assigned)).toBe('Sam assigned you PAY-3');
    expect(notificationHref(assigned)).toBe('/projects/PAY/issues/PAY-3');

    const comment = Notification.parse({ ...base, type: 'COMMENT_ADDED', payload: issuePayload });
    expect(describeNotification(comment)).toBe('Sam commented on PAY-3');

    const started = Notification.parse({ ...base, type: 'SPRINT_STARTED', payload: sprintPayload });
    expect(describeNotification(started)).toBe('Priya started PAY Sprint 2');
    expect(notificationHref(started)).toBe('/projects/PAY/sprints');
  });

  it('requires the payload shape that matches the type', () => {
    expect(
      Notification.safeParse({ ...base, type: 'SPRINT_STARTED', payload: issuePayload }).success,
    ).toBe(false);
    expect(
      Notification.safeParse({ ...base, type: 'ISSUE_ASSIGNED', payload: sprintPayload }).success,
    ).toBe(false);
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
