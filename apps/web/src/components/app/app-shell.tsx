'use client';

import { Button } from '@forge/ui/components/button';
import { LogOut } from 'lucide-react';
import type { ReactNode } from 'react';

import { useAuth } from '@/components/auth/auth-provider';

/** Signed-in chrome. The proxy already redirected visitors without a session hint. */
export function AppShell({ children }: { children: ReactNode }) {
  const { state, logout } = useAuth();

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
        <div className="mx-auto flex h-14 max-w-5xl items-center justify-between px-6">
          <span className="font-bold tracking-tight">Forge</span>
          <div className="flex items-center gap-3 text-sm">
            <span aria-label="Signed in as">{state.user.displayName}</span>
            <Button variant="ghost" size="sm" onClick={() => void logout()}>
              <LogOut aria-hidden="true" />
              Sign out
            </Button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-6 py-8">{children}</main>
    </div>
  );
}
