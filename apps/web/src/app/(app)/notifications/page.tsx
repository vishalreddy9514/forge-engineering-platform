'use client';

import { describeNotification, type Notification } from '@forge/types';
import { Alert } from '@forge/ui/components/alert';
import { Button } from '@forge/ui/components/button';
import { Skeleton } from '@forge/ui/components/skeleton';
import { cn } from '@forge/ui/lib/utils';
import { CheckCheck } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import {
  useMarkAllRead,
  useMarkRead,
  useNotifications,
  useUnreadCount,
} from '@/lib/queries/notifications';

function NotificationItem({ notification }: { notification: Notification }) {
  const router = useRouter();
  const markRead = useMarkRead();
  const { payload } = notification;
  const unread = notification.readAt === null;

  const open = () => {
    if (unread) markRead.mutate(notification.id);
    router.push(`/projects/${payload.projectKey}/issues/${payload.issueKey}`);
  };

  return (
    <li>
      <button
        type="button"
        onClick={open}
        className={cn(
          'flex w-full items-start gap-3 rounded-lg px-3 py-3 text-left hover:bg-muted',
          unread && 'bg-muted/50',
        )}
      >
        <span
          aria-hidden="true"
          className={cn(
            'mt-1.5 size-2 shrink-0 rounded-full',
            unread ? 'bg-blue-600' : 'bg-transparent',
          )}
        />
        <span className="grid min-w-0 gap-0.5">
          <span className={cn('text-sm', unread && 'font-medium')}>
            {describeNotification(notification)}
            {unread && <span className="sr-only"> (unread)</span>}
          </span>
          <span className="truncate text-sm text-muted-foreground">{payload.issueTitle}</span>
          <time dateTime={notification.createdAt} className="text-xs text-muted-foreground">
            {new Date(notification.createdAt).toLocaleString()}
          </time>
        </span>
      </button>
    </li>
  );
}

export default function NotificationsPage() {
  const [unreadOnly, setUnreadOnly] = useState(false);
  const { data, isPending, isError, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useNotifications(unreadOnly);
  const { data: unread } = useUnreadCount();
  const markAll = useMarkAllRead();
  const items = data?.pages.flatMap((page) => page.data) ?? [];

  return (
    <div className="mx-auto grid max-w-2xl gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-3xl font-bold tracking-tight">Notifications</h1>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={unreadOnly}
              onChange={(e) => {
                setUnreadOnly(e.target.checked);
              }}
            />
            Unread only
          </label>
          <Button
            variant="outline"
            size="sm"
            disabled={!unread?.count || markAll.isPending}
            onClick={() => {
              markAll.mutate();
            }}
          >
            <CheckCheck aria-hidden="true" />
            Mark all as read
          </Button>
        </div>
      </div>

      {isPending ? (
        <Skeleton className="h-40" />
      ) : isError ? (
        <Alert variant="destructive">Notifications could not be loaded.</Alert>
      ) : items.length === 0 ? (
        <p className="rounded-xl border border-dashed p-10 text-center text-sm text-muted-foreground">
          {unreadOnly ? "You're all caught up." : 'No notifications yet.'}
        </p>
      ) : (
        <ul className="grid gap-1">
          {items.map((n) => (
            <NotificationItem key={n.id} notification={n} />
          ))}
        </ul>
      )}
      {hasNextPage && (
        <Button
          variant="outline"
          onClick={() => void fetchNextPage()}
          disabled={isFetchingNextPage}
        >
          {isFetchingNextPage ? 'Loading…' : 'Load more'}
        </Button>
      )}
    </div>
  );
}
