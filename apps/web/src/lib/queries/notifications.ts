import { cursorPage, Notification, UnreadCount } from '@forge/types';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiFetch, apiJson } from '@/lib/api';

export const notificationKeys = {
  all: ['notifications'] as const,
  unread: ['notifications', 'unread-count'] as const,
  list: (unreadOnly: boolean) => ['notifications', 'list', { unreadOnly }] as const,
};

/** FR-12.4 fallback: poll every 30 s (and on focus) until server push arrives. */
export const UNREAD_POLL_MS = 30_000;

const NotificationPage = cursorPage(Notification);

export function useUnreadCount() {
  return useQuery({
    queryKey: notificationKeys.unread,
    queryFn: () => apiJson('/notifications/unread-count', UnreadCount),
    refetchInterval: UNREAD_POLL_MS,
    refetchOnWindowFocus: true,
  });
}

export function useNotifications(unreadOnly: boolean) {
  return useInfiniteQuery({
    queryKey: notificationKeys.list(unreadOnly),
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ limit: '25' });
      if (unreadOnly) params.set('unread', 'true');
      if (pageParam) params.set('cursor', pageParam);
      return apiJson(`/notifications?${params.toString()}`, NotificationPage);
    },
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
  });
}

function useNotificationMutation<T>(fn: (arg: T) => Promise<unknown>) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSettled: () => client.invalidateQueries({ queryKey: notificationKeys.all }),
  });
}

export const useMarkRead = () =>
  useNotificationMutation((id: string) =>
    apiFetch(`/notifications/${id}/read`, { method: 'POST' }),
  );

export const useMarkAllRead = () =>
  useNotificationMutation(() => apiFetch('/notifications/read-all', { method: 'POST' }));
