'use client';

import type { IssueDetail, UpdateIssueRequest } from '@forge/types';
import { Alert } from '@forge/ui/components/alert';
import { Button } from '@forge/ui/components/button';
import { Input } from '@forge/ui/components/input';
import { Label } from '@forge/ui/components/label';
import { Skeleton } from '@forge/ui/components/skeleton';
import { Textarea } from '@forge/ui/components/textarea';
import { Pencil, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';

import { CommentThread } from '@/components/issues/comment-thread';
import { StatusBadge, TypeIcon } from '@/components/issues/issue-badges';
import { IssueSidebar } from '@/components/issues/issue-sidebar';
import { Markdown } from '@/components/markdown';
import { useCan, useCurrentProject } from '@/components/projects/project-context';
import { ApiError } from '@/lib/api';
import { describeEvent } from '@/lib/issue-events';
import { useDeleteIssue, useIssue, useIssueEvents, useUpdateIssue } from '@/lib/queries/issues';
import { useLabels, useMembers } from '@/lib/queries/projects';

type Change = Omit<UpdateIssueRequest, 'version'>;

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 409) {
      return 'Someone else changed this issue while you were editing. The latest version is shown; please apply your change again.';
    }
    const field = error.problem?.errors?.[0];
    if (field) return field.message;
    if (error.status < 500) return error.message;
  }
  return 'The change could not be saved. Please try again.';
}

function History({ issueId }: { issueId: string }) {
  const { data: events, isPending, isError } = useIssueEvents(issueId);
  if (isPending) return <p className="text-sm text-muted-foreground">Loading history…</p>;
  if (isError) return <Alert variant="destructive">History could not be loaded.</Alert>;
  return (
    <ol className="grid gap-2 border-l pl-4 text-sm">
      {events.map((event) => (
        <li key={event.id}>
          <span className="font-medium">{event.actor?.displayName ?? 'Someone'}</span>{' '}
          {describeEvent(event)}{' '}
          <time dateTime={event.createdAt} className="text-muted-foreground">
            {new Date(event.createdAt).toLocaleString()}
          </time>
        </li>
      ))}
    </ol>
  );
}

function IssueView({ issue }: { issue: IssueDetail }) {
  const project = useCurrentProject();
  const router = useRouter();
  const canEdit = useCan('issue:update');
  const canDelete = useCan('issue:delete');
  const canComment = useCan('comment:create');
  const canModerate = useCan('comment:moderate');
  const update = useUpdateIssue(issue);
  const remove = useDeleteIssue(issue);
  const { data: members = [] } = useMembers(project.id);
  const { data: labels = [] } = useLabels(project.id);

  const [error, setError] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState(false);
  const [title, setTitle] = useState(issue.title);
  const [editingDescription, setEditingDescription] = useState(false);
  const [description, setDescription] = useState(issue.description ?? '');
  const [tab, setTab] = useState<'comments' | 'history'>('comments');

  const save = async (change: Change): Promise<boolean> => {
    setError(null);
    try {
      await update.mutateAsync({ version: issue.version, ...change });
      return true;
    } catch (e) {
      setError(errorMessage(e));
      return false;
    }
  };

  const saveTitle = async () => {
    const next = title.trim();
    if (!next) {
      setError('Enter a title');
      return;
    }
    if (next === issue.title || (await save({ title: next }))) setEditingTitle(false);
  };

  const saveDescription = async () => {
    const next = description.trim() === '' ? null : description;
    if (next === issue.description || (await save({ description: next }))) {
      setEditingDescription(false);
    }
  };

  const deleteIssue = async () => {
    if (!window.confirm(`Delete ${issue.key}? It will disappear from lists and the board.`)) return;
    setError(null);
    try {
      await remove.mutateAsync();
      router.push(`/projects/${project.key}/issues`);
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <div className="grid gap-6">
      <nav aria-label="Breadcrumb" className="text-sm text-muted-foreground">
        <Link href={`/projects/${project.key}/issues`} className="hover:underline">
          Issues
        </Link>{' '}
        / <span className="font-mono">{issue.key}</span>
      </nav>

      {error && (
        <Alert variant="destructive" role="alert">
          {error}
        </Alert>
      )}

      <div className="grid gap-8 lg:grid-cols-[1fr_18rem]">
        <div className="grid min-w-0 content-start gap-6">
          <header className="grid gap-2">
            <div className="flex items-center gap-2 text-sm">
              <TypeIcon type={issue.type} withLabel />
              <StatusBadge status={issue.status} />
            </div>
            {editingTitle ? (
              <form
                className="flex gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  void saveTitle();
                }}
              >
                <Label htmlFor="edit-title" className="sr-only">
                  Title
                </Label>
                <Input
                  id="edit-title"
                  value={title}
                  maxLength={200}
                  onChange={(e) => {
                    setTitle(e.target.value);
                  }}
                  autoFocus
                />
                <Button type="submit" disabled={update.isPending}>
                  Save
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    setTitle(issue.title);
                    setEditingTitle(false);
                  }}
                >
                  Cancel
                </Button>
              </form>
            ) : (
              <div className="flex items-start gap-2">
                <h2 className="text-2xl font-semibold break-words">{issue.title}</h2>
                {canEdit && (
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Edit title"
                    onClick={() => {
                      setTitle(issue.title);
                      setEditingTitle(true);
                    }}
                  >
                    <Pencil aria-hidden="true" />
                  </Button>
                )}
              </div>
            )}
          </header>

          <section aria-labelledby="description-heading" className="grid gap-2">
            <div className="flex items-center justify-between">
              <h3 id="description-heading" className="text-sm font-semibold">
                Description
              </h3>
              {canEdit && !editingDescription && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setDescription(issue.description ?? '');
                    setEditingDescription(true);
                  }}
                >
                  <Pencil aria-hidden="true" />
                  Edit
                </Button>
              )}
            </div>
            {editingDescription ? (
              <form
                className="grid gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  void saveDescription();
                }}
              >
                <Label htmlFor="edit-description" className="sr-only">
                  Description (Markdown)
                </Label>
                <Textarea
                  id="edit-description"
                  rows={10}
                  value={description}
                  onChange={(e) => {
                    setDescription(e.target.value);
                  }}
                />
                <div className="flex justify-end gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => {
                      setEditingDescription(false);
                    }}
                  >
                    Cancel
                  </Button>
                  <Button type="submit" disabled={update.isPending}>
                    Save
                  </Button>
                </div>
              </form>
            ) : issue.description ? (
              <Markdown>{issue.description}</Markdown>
            ) : (
              <p className="text-sm text-muted-foreground">No description.</p>
            )}
          </section>

          <div>
            <div role="tablist" aria-label="Activity" className="mb-4 flex gap-1 border-b">
              {(['comments', 'history'] as const).map((name) => (
                <button
                  key={name}
                  type="button"
                  role="tab"
                  aria-selected={tab === name}
                  onClick={() => {
                    setTab(name);
                  }}
                  className={
                    tab === name
                      ? '-mb-px border-b-2 border-foreground px-3 py-2 text-sm font-medium'
                      : '-mb-px border-b-2 border-transparent px-3 py-2 text-sm text-muted-foreground hover:text-foreground'
                  }
                >
                  {name === 'comments' ? 'Comments' : 'History'}
                </button>
              ))}
            </div>
            <div role="tabpanel">
              {tab === 'comments' ? (
                <CommentThread issue={issue} canComment={canComment} canModerate={canModerate} />
              ) : (
                <History issueId={issue.id} />
              )}
            </div>
          </div>
        </div>

        <div className="grid content-start gap-3">
          <IssueSidebar
            issue={issue}
            members={members}
            labels={labels}
            canEdit={canEdit}
            onChange={(change) => void save(change)}
          />
          {canDelete && (
            <Button
              variant="outline"
              onClick={() => void deleteIssue()}
              disabled={remove.isPending}
            >
              <Trash2 aria-hidden="true" />
              Delete issue
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

export default function IssuePage() {
  const { issueKey } = useParams<{ issueKey: string }>();
  const project = useCurrentProject();
  const { data: issue, error, isPending } = useIssue(issueKey);

  if (isPending) return <Skeleton className="h-64" />;
  // An issue key from another project is not shown under this project's navigation.
  const elsewhere = issue !== undefined && issue.projectKey !== project.key;
  if (error || elsewhere) {
    const missing = elsewhere || (error instanceof ApiError && error.status === 404);
    return (
      <div className="rounded-xl border border-dashed p-10 text-center">
        <h2 className="text-xl font-semibold">
          {missing ? 'Issue not found' : 'Something went wrong'}
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          {missing
            ? 'It may have been deleted.'
            : 'The issue could not be loaded. Please try again.'}
        </p>
        <Link
          href={`/projects/${project.key}/issues`}
          className="mt-4 inline-block text-sm underline"
        >
          Back to issues
        </Link>
      </div>
    );
  }
  // Keyed by ID so drafts reset when navigating between issues.
  return <IssueView key={issue.id} issue={issue} />;
}
