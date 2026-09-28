'use client';

import { Alert } from '@forge/ui/components/alert';
import { Skeleton } from '@forge/ui/components/skeleton';
import { useState } from 'react';

import { useAuth } from '@/components/auth/auth-provider';
import { CodeActivity } from '@/components/github/code-activity';
import { LinkRepositoryDialog } from '@/components/github/link-repository-dialog';
import { RepositoryCard } from '@/components/github/repository-card';
import { useCan, useCurrentProject } from '@/components/projects/project-context';
import {
  useGithubStatus,
  useLinkedRepositories,
  useRequestSync,
  useUnlinkRepository,
} from '@/lib/queries/github';

/** The project's GitHub repositories and what was synced from them (FR-6). */
export default function CodePage() {
  const project = useCurrentProject();
  const { state } = useAuth();
  const isAdmin = state.status === 'authenticated' && state.user.isAdmin;
  const canLink = useCan('github:link');
  const canSync = useCan('github:sync');
  const { data: status } = useGithubStatus();
  const { data: repositories, isPending, isError } = useLinkedRepositories(project.id);
  const sync = useRequestSync(project.id);
  const unlink = useUnlinkRepository(project.id);
  const [error, setError] = useState<string | null>(null);

  const configured = status?.configured ?? true;

  const run = async (action: () => Promise<unknown>, failure: string) => {
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : failure);
    }
  };

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-xl font-semibold">Code</h2>
        {canLink && configured && <LinkRepositoryDialog projectId={project.id} isAdmin={isAdmin} />}
      </div>

      {!configured && (
        <Alert>
          The GitHub integration is not configured on this server, so repositories cannot be linked
          or synced. Data synced earlier is still shown.
        </Alert>
      )}
      {error && (
        <Alert variant="destructive" role="alert">
          {error}
        </Alert>
      )}

      {isPending ? (
        <Skeleton className="h-32" />
      ) : isError ? (
        <Alert variant="destructive">Repositories could not be loaded.</Alert>
      ) : repositories.length === 0 ? (
        <div className="rounded-xl border border-dashed p-10 text-center">
          <h3 className="font-semibold">No repositories linked</h3>
          <p className="mt-2 text-sm text-muted-foreground">
            {canLink
              ? 'Link a GitHub repository to see its pull requests and commits here, and on the issues they mention.'
              : 'A project manager can link GitHub repositories to this project.'}
          </p>
        </div>
      ) : (
        <>
          <ul className="grid gap-3" aria-label="Linked repositories">
            {repositories.map((repo) => (
              <RepositoryCard
                key={repo.id}
                repository={repo}
                canSync={canSync && configured}
                canUnlink={canLink}
                syncing={sync.isPending && sync.variables === repo.id}
                onSync={() =>
                  void run(() => sync.mutateAsync(repo.id), 'The sync could not be started.')
                }
                onUnlink={() => {
                  if (
                    window.confirm(
                      `Unlink ${repo.fullName}? Its pull requests and commits will no longer appear on this project's issues.`,
                    )
                  ) {
                    void run(
                      () => unlink.mutateAsync(repo.id),
                      'The repository could not be unlinked.',
                    );
                  }
                }}
              />
            ))}
          </ul>
          <CodeActivity projectId={project.id} repositories={repositories} />
        </>
      )}
    </div>
  );
}
