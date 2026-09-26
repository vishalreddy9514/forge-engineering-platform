'use client';

import { useAuth } from '@/components/auth/auth-provider';
import { SystemStatus } from '@/components/system-status';

export default function HomePage() {
  const { state } = useAuth();
  return (
    <div className="grid gap-8">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">
          Welcome{state.user ? `, ${state.user.displayName.split(' ')[0] ?? ''}` : ''}
        </h1>
        <p className="mt-2 text-muted-foreground">
          Projects, issues and sprints arrive in the next phases.
        </p>
      </div>
      <SystemStatus />
    </div>
  );
}
