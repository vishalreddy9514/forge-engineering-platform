'use client';

import { Alert } from '@forge/ui/components/alert';
import { Button } from '@forge/ui/components/button';
import { Skeleton } from '@forge/ui/components/skeleton';
import { ExternalLink, Lock } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef, useState } from 'react';

import { useAuth } from '@/components/auth/auth-provider';
import { ApiError } from '@/lib/api';
import { useClaimInstallation, useGithubStatus, useInstallations } from '@/lib/queries/github';

/**
 * GitHub connections (FR-6.1). Administrators install the Forge GitHub App from here, and GitHub
 * redirects back with `?installation_id=…&setup_action=install`; the page then asks the API to
 * record it (the API confirms the ID with GitHub first).
 */
function GithubConnections() {
  const { state } = useAuth();
  const isAdmin = state.status === 'authenticated' && state.user.isAdmin;
  const params = useSearchParams();
  const router = useRouter();
  const { data: status, isPending: statusPending } = useGithubStatus();
  const installations = useInstallations(isAdmin);
  const claim = useClaimInstallation();
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const claimed = useRef(false);

  const installationId = Number(params.get('installation_id'));
  useEffect(() => {
    if (
      !isAdmin ||
      claimed.current ||
      !Number.isSafeInteger(installationId) ||
      installationId <= 0
    ) {
      return;
    }
    claimed.current = true;
    claim
      .mutateAsync(installationId)
      .then((installation) => {
        setMessage({
          ok: true,
          text: `Connected ${installation.accountLogin}. Its repositories are being fetched; link them to projects from each project's Code tab.`,
        });
      })
      .catch((e: unknown) => {
        setMessage({
          ok: false,
          text:
            e instanceof ApiError && e.status === 404
              ? 'GitHub does not know that installation for this App.'
              : 'The installation could not be connected. Please try again.',
        });
      })
      .finally(() => {
        router.replace('/github'); // drop the query string so a reload does not repeat it
      });
  }, [claim, installationId, isAdmin, router]);

  if (statusPending) return <Skeleton className="h-40" />;

  return (
    <div className="grid gap-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">GitHub</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Forge reads repositories through its GitHub App, with read-only access, and never writes
          to GitHub.
        </p>
      </div>

      {message && (
        <Alert variant={message.ok ? 'default' : 'destructive'} role="status">
          {message.text}
        </Alert>
      )}

      {!status?.configured ? (
        <Alert>
          No GitHub App is configured on this server. An operator sets one up as described in
          docs/github-app-setup.md.
        </Alert>
      ) : !isAdmin ? (
        <p className="text-sm text-muted-foreground">
          An administrator connects GitHub accounts and organisations. Once connected, project
          managers link repositories from each project&apos;s Code tab.
          {installationId > 0 &&
            ' GitHub has notified Forge of your installation; an administrator will see it here.'}
        </p>
      ) : (
        <>
          {status.installUrl && (
            <div>
              <Button asChild>
                <a href={status.installUrl}>
                  <ExternalLink aria-hidden="true" />
                  Install on GitHub
                </a>
              </Button>
            </div>
          )}
          {installations.isPending ? (
            <Skeleton className="h-24" />
          ) : installations.isError ? (
            <Alert variant="destructive">Connections could not be loaded.</Alert>
          ) : installations.data.length === 0 ? (
            <p className="text-sm text-muted-foreground">No GitHub accounts connected yet.</p>
          ) : (
            <ul className="grid gap-3">
              {installations.data.map((i) => (
                <li key={i.id} className="grid gap-2 rounded-xl border p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="font-medium">{i.accountLogin}</h2>
                    <span className="text-xs text-muted-foreground">
                      {i.accountType === 'ORGANIZATION' ? 'Organisation' : 'User'}
                    </span>
                    {i.suspended && (
                      <span className="rounded bg-destructive/10 px-2 text-xs text-destructive">
                        Suspended
                      </span>
                    )}
                  </div>
                  {i.repositories.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No repositories granted yet.</p>
                  ) : (
                    <ul className="flex flex-wrap gap-2 text-sm">
                      {i.repositories.map((r) => (
                        <li
                          key={r.id}
                          className="flex items-center gap-1 rounded border px-2 py-0.5"
                        >
                          {r.isPrivate && (
                            <Lock className="size-3 text-muted-foreground" aria-label="Private" />
                          )}
                          {r.fullName}
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

export default function GithubPage() {
  // useSearchParams needs a Suspense boundary for static rendering.
  return (
    <Suspense fallback={<Skeleton className="h-40" />}>
      <GithubConnections />
    </Suspense>
  );
}
