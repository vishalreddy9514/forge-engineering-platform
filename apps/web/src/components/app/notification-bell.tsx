'use client';

import { cn } from '@forge/ui/lib/utils';
import { Bell } from 'lucide-react';
import Link from 'next/link';

import { useUnreadCount } from '@/lib/queries/notifications';

export function NotificationBell({ active }: { active: boolean }) {
  const { data } = useUnreadCount();
  const count = data?.count ?? 0;
  const label = count > 0 ? `Notifications, ${String(count)} unread` : 'Notifications';
  return (
    <Link
      href="/notifications"
      aria-label={label}
      title={label}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'relative inline-flex size-9 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground',
        active && 'text-foreground',
      )}
    >
      <Bell className="size-4" aria-hidden="true" />
      {count > 0 && (
        <span
          aria-hidden="true"
          className="absolute -top-0.5 -right-0.5 min-w-4 rounded-full bg-destructive px-1 text-center text-[10px] leading-4 font-semibold text-white"
        >
          {count > 99 ? '99+' : count}
        </span>
      )}
    </Link>
  );
}
