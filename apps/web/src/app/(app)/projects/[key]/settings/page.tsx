'use client';

import { UpdateProjectRequest } from '@forge/types';
import { Alert } from '@forge/ui/components/alert';
import { Button } from '@forge/ui/components/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@forge/ui/components/card';
import { Input } from '@forge/ui/components/input';
import { Label } from '@forge/ui/components/label';
import { Select } from '@forge/ui/components/select';
import { Textarea } from '@forge/ui/components/textarea';
import { useRouter } from 'next/navigation';
import { type SyntheticEvent, useState } from 'react';

import { useAuth } from '@/components/auth/auth-provider';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { useCan, useCurrentProject } from '@/components/projects/project-context';
import { ApiError } from '@/lib/api';
import {
  useDeleteProject,
  useMembers,
  useSetArchived,
  useUpdateProject,
} from '@/lib/queries/projects';

export default function ProjectSettingsPage() {
  const project = useCurrentProject();
  const canEdit = useCan('project:update');
  const canArchive = useCan('project:archive');
  const { state } = useAuth();

  if (!canEdit && !canArchive) {
    return (
      <p className="text-sm text-muted-foreground">
        Only project managers can change project settings.
      </p>
    );
  }
  return (
    <div className="grid gap-6">
      {canEdit && <DetailsForm />}
      {canArchive && <ArchiveCard />}
      {state.user?.isAdmin && project.archivedAt && <DeleteCard />}
    </div>
  );
}

function DetailsForm() {
  const project = useCurrentProject();
  const update = useUpdateProject(project.id);
  const { data: members } = useMembers(project.id);
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description ?? '');
  const [assignee, setAssignee] = useState(project.defaultAssignee?.id ?? '');
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const submit = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    const parsed = UpdateProjectRequest.safeParse({
      name,
      description: description.trim() || null,
      defaultAssigneeId: assignee || null,
    });
    if (!parsed.success) {
      setMessage({ ok: false, text: parsed.error.issues[0]?.message ?? 'Invalid input' });
      return;
    }
    try {
      await update.mutateAsync(parsed.data);
      setMessage({ ok: true, text: 'Saved.' });
    } catch (error) {
      setMessage({
        ok: false,
        text:
          error instanceof ApiError
            ? (error.problem?.errors?.[0]?.message ?? error.message)
            : 'Could not save',
      });
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>Details</h2>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={(e) => void submit(e)} className="grid max-w-xl gap-4">
          {message && (
            <Alert variant={message.ok ? 'success' : 'destructive'}>{message.text}</Alert>
          )}
          <div className="grid gap-2">
            <Label htmlFor="project-name">Name</Label>
            <Input
              id="project-name"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
              }}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="project-key">Key</Label>
            <Input id="project-key" value={project.key} disabled className="font-mono" />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="project-description">Description</Label>
            <Textarea
              id="project-description"
              rows={4}
              value={description}
              onChange={(e) => {
                setDescription(e.target.value);
              }}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="default-assignee">Default assignee for new issues</Label>
            <Select
              id="default-assignee"
              value={assignee}
              onChange={(e) => {
                setAssignee(e.target.value);
              }}
            >
              <option value="">Nobody (unassigned)</option>
              {members?.map((m) => (
                <option key={m.user.id} value={m.user.id}>
                  {m.user.displayName}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <Button type="submit" disabled={update.isPending}>
              Save changes
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function ArchiveCard() {
  const project = useCurrentProject();
  const setArchived = useSetArchived(project.id);
  const archived = Boolean(project.archivedAt);
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>{archived ? 'Restore project' : 'Archive project'}</h2>
        </CardTitle>
        <CardDescription>
          {archived
            ? 'Restoring makes the project editable again.'
            : 'Archived projects are read-only and hidden from the default project list. Nothing is deleted.'}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ConfirmDialog
          title={archived ? `Restore ${project.name}?` : `Archive ${project.name}?`}
          description={
            archived
              ? 'Members will be able to change it again.'
              : 'Members keep read access, but nobody can change anything until it is restored.'
          }
          confirmLabel={archived ? 'Restore' : 'Archive'}
          onConfirm={() => setArchived.mutateAsync(!archived)}
          trigger={(open) => (
            <Button variant="outline" onClick={open}>
              {archived ? 'Restore project' : 'Archive project'}
            </Button>
          )}
        />
      </CardContent>
    </Card>
  );
}

function DeleteCard() {
  const project = useCurrentProject();
  const router = useRouter();
  const remove = useDeleteProject(project.id);
  const [typed, setTyped] = useState('');
  return (
    <Card className="border-destructive/50">
      <CardHeader>
        <CardTitle>
          <h2>Delete permanently</h2>
        </CardTitle>
        <CardDescription>
          Admins only. Deletes the project with all its issues, sprints and labels. This cannot be
          undone.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid max-w-sm gap-3">
        <Label htmlFor="confirm-key">
          Type <span className="font-mono">{project.key}</span> to confirm
        </Label>
        <Input
          id="confirm-key"
          value={typed}
          onChange={(e) => {
            setTyped(e.target.value);
          }}
        />
        <ConfirmDialog
          title={`Delete ${project.name} forever?`}
          description="All issues, sprints, labels and history in this project will be erased."
          confirmLabel="Delete forever"
          destructive
          onConfirm={async () => {
            await remove.mutateAsync(typed);
            router.replace('/projects');
          }}
          trigger={(open) => (
            <Button
              variant="destructive"
              disabled={typed.toUpperCase() !== project.key}
              onClick={open}
            >
              Delete project
            </Button>
          )}
        />
      </CardContent>
    </Card>
  );
}
