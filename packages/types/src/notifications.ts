import { z } from 'zod';

import { CursorPaginationQuery } from './pagination';

/**
 * Display data captured when the notification is created, so the list renders without joins
 * and still makes sense if the issue is later renamed.
 */
export const IssueNotificationPayload = z.object({
  projectKey: z.string(),
  issueKey: z.string(),
  issueTitle: z.string(),
  actorName: z.string(),
});
export type IssueNotificationPayload = z.infer<typeof IssueNotificationPayload>;

export const SprintNotificationPayload = z.object({
  projectKey: z.string(),
  sprintId: z.string(),
  sprintName: z.string(),
  actorName: z.string(),
});
export type SprintNotificationPayload = z.infer<typeof SprintNotificationPayload>;

export const NotificationPayload = z.union([IssueNotificationPayload, SprintNotificationPayload]);
export type NotificationPayload = z.infer<typeof NotificationPayload>;

const ISSUE_TYPES = ['ISSUE_ASSIGNED', 'COMMENT_ADDED', 'MENTIONED'] as const;
const SPRINT_TYPES = ['SPRINT_STARTED', 'SPRINT_COMPLETED'] as const;

const base = { id: z.uuid(), readAt: z.string().nullable(), createdAt: z.string() };

/** Each notification type carries the payload shape that type is written with. */
export const Notification = z.discriminatedUnion('type', [
  z.object({ ...base, type: z.enum(ISSUE_TYPES), payload: IssueNotificationPayload }),
  z.object({ ...base, type: z.enum(SPRINT_TYPES), payload: SprintNotificationPayload }),
]);
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
export function describeNotification(notification: Notification): string {
  switch (notification.type) {
    case 'ISSUE_ASSIGNED':
      return `${notification.payload.actorName} assigned you ${notification.payload.issueKey}`;
    case 'COMMENT_ADDED':
      return `${notification.payload.actorName} commented on ${notification.payload.issueKey}`;
    case 'MENTIONED':
      return `${notification.payload.actorName} mentioned you on ${notification.payload.issueKey}`;
    case 'SPRINT_STARTED':
      return `${notification.payload.actorName} started ${notification.payload.sprintName}`;
    case 'SPRINT_COMPLETED':
      return `${notification.payload.actorName} completed ${notification.payload.sprintName}`;
  }
}

/** Where a notification leads in the web app. */
export function notificationHref(notification: Notification): string {
  switch (notification.type) {
    case 'SPRINT_STARTED':
    case 'SPRINT_COMPLETED':
      return `/projects/${notification.payload.projectKey}/sprints`;
    default:
      return `/projects/${notification.payload.projectKey}/issues/${notification.payload.issueKey}`;
  }
}
