'use client';

import { Alert } from '@forge/ui/components/alert';
import { Button } from '@forge/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  DialogTrigger,
} from '@forge/ui/components/dialog';
import { Label } from '@forge/ui/components/label';
import { Select } from '@forge/ui/components/select';
import { Plus } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';

import { useAvailableRepositories, useLinkRepository } from '@/lib/queries/github';

/** Links a repository from a connected installation to this project (FR-6.2). */
export function LinkRepositoryDialog({
  projectId,
  isAdmin,
}: {
  projectId: string;
  isAdmin: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [repositoryId, setRepositoryId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const { data: available, isPending } = useAvailableRepositories(projectId, open);
  const link = useLinkRepository(projectId);

  const submit = async () => {
    if (!repositoryId) {
      setError('Choose a repository');
      return;
    }
    setError(null);
    try {
      await link.mutateAsync(repositoryId);
      setOpen(false);
      setRepositoryId('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The repository could not be linked.');
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus aria-hidden="true" />
          Link repository
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogTitle>Link a repository</DialogTitle>
        <DialogDescription>
          Forge syncs its pull requests, commits and issues, and links any that mention this
          project&apos;s issue keys.
        </DialogDescription>
        {isPending ? (
          <p className="text-sm text-muted-foreground">Loading repositories…</p>
        ) : !available || available.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No other repositories are available.{' '}
            {isAdmin ? (
              <Link href="/github" className="underline">
                Connect a GitHub account or organisation
              </Link>
            ) : (
              'An administrator can install the Forge GitHub App on more repositories.'
            )}
          </p>
        ) : (
          <div className="grid gap-1.5">
            <Label htmlFor="link-repository">Repository</Label>
            <Select
              id="link-repository"
              value={repositoryId}
              onChange={(e) => {
                setRepositoryId(e.target.value);
              }}
            >
              <option value="">Choose…</option>
              {available.map((repo) => (
                <option key={repo.id} value={repo.id}>
                  {repo.fullName}
                  {repo.isPrivate ? ' (private)' : ''}
                </option>
              ))}
            </Select>
          </div>
        )}
        {error && (
          <Alert variant="destructive" role="alert">
            {error}
          </Alert>
        )}
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => {
              setOpen(false);
            }}
          >
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={link.isPending || !available?.length}>
            Link
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
