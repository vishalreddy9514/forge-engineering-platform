'use client';

import { Button } from '@forge/ui/components/button';
import { cn } from '@forge/ui/lib/utils';
import { Bot, FolderKanban, GitPullRequest, LogOut, Search } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';

import { NotificationBell } from '@/components/app/notification-bell';
import { useAuth } from '@/components/auth/auth-provider';

/** Signed-in chrome. The proxy already redirected visitors without a session hint. */
export function AppShell({ children }: { children: ReactNode }) {
  const { state, logout } = useAuth();
  const pathname = usePathname();

  if (state.status === 'loading') {
    return (
      <p role="status" className="p-8 text-center text-sm text-muted-foreground">
        Loading your workspace…
      </p>
    );
  }
  // The hint cookie existed but the session did not (expired/revoked): the provider redirects.
  if (state.status === 'anonymous') return null;

  return (
    <div className="min-h-screen">
      <header className="border-b">
        <div className="mx-auto flex min-h-14 max-w-5xl flex-wrap items-center justify-between gap-x-6 gap-y-2 px-4 py-2 sm:px-6">
          <nav aria-label="Main" className="flex flex-wrap items-center gap-x-6 gap-y-2">
            <Link href="/" className="font-bold tracking-tight">
              Forge
            </Link>
            <Link
              href="/projects"
              aria-current={pathname.startsWith('/projects') ? 'page' : undefined}
              className={cn(
                'flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground',
                pathname.startsWith('/projects') && 'font-medium text-foreground',
              )}
            >
              <FolderKanban className="size-4" aria-hidden="true" />
              Projects
            </Link>
            <NavLink href="/search" active={pathname.startsWith('/search')} icon={Search}>
              Search
            </NavLink>
            <NavLink href="/assistant" active={pathname.startsWith('/assistant')} icon={Bot}>
              Assistant
            </NavLink>
            {state.user.isAdmin && (
              <Link
                href="/github"
                aria-current={pathname.startsWith('/github') ? 'page' : undefined}
                className={cn(
                  'flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground',
                  pathname.startsWith('/github') && 'font-medium text-foreground',
                )}
              >
                <GitPullRequest className="size-4" aria-hidden="true" />
                GitHub
              </Link>
            )}
          </nav>
          <div className="flex items-center gap-3 text-sm">
            <NotificationBell active={pathname.startsWith('/notifications')} />
            <span aria-label="Signed in as" className="hidden sm:inline">
              {state.user.displayName}
            </span>
            <Button variant="ghost" size="sm" onClick={() => void logout()}>
              <LogOut aria-hidden="true" />
              Sign out
            </Button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-4 py-8 sm:px-6">{children}</main>
    </div>
  );
}

function NavLink({
  href,
  active,
  icon: Icon,
  children,
}: {
  href: string;
  active: boolean;
  icon: typeof Search;
  children: ReactNode;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground',
        active && 'font-medium text-foreground',
      )}
    >
      <Icon className="size-4" aria-hidden="true" />
      {children}
    </Link>
  );
}
