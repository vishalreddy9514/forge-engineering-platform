import { z } from 'zod';

import { NotificationType } from './enums';
import { CursorPaginationQuery } from './pagination';

/**
 * Display data captured when the notification is created, so the list renders without joins
 * and still makes sense if the issue is later renamed.
 */
export const NotificationPayload = z.object({
  projectKey: z.string(),
  issueKey: z.string(),
  issueTitle: z.string(),
  actorName: z.string(),
});
export type NotificationPayload = z.infer<typeof NotificationPayload>;

export const Notification = z.object({
  id: z.uuid(),
  type: NotificationType,
  payload: NotificationPayload,
  readAt: z.string().nullable(),
  createdAt: z.string(),
});
export type Notification = z.infer<typeof Notification>;

export const ListNotificationsQuery = CursorPaginationQuery.extend({
  unread: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),
});
export type ListNotificationsQuery = z.infer<typeof ListNotificationsQuery>;

export const UnreadCount = z.object({ count: z.number().int().min(0) });
export type UnreadCount = z.infer<typeof UnreadCount>;

/** One line of text for a notification, e.g. "Sam Okafor assigned you PAY-3". */
export function describeNotification(notification: Pick<Notification, 'type' | 'payload'>): string {
  const { actorName, issueKey } = notification.payload;
  switch (notification.type) {
    case 'ISSUE_ASSIGNED':
      return `${actorName} assigned you ${issueKey}`;
    case 'COMMENT_ADDED':
      return `${actorName} commented on ${issueKey}`;
    case 'MENTIONED':
      return `${actorName} mentioned you on ${issueKey}`;
    default:
      return `${actorName} updated ${issueKey}`;
  }
}
