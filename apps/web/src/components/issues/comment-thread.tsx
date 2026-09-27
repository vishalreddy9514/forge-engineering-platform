'use client';

import { type Comment, CreateCommentRequest } from '@forge/types';
import { Alert } from '@forge/ui/components/alert';
import { Button } from '@forge/ui/components/button';
import { Label } from '@forge/ui/components/label';
import { Textarea } from '@forge/ui/components/textarea';
import { zodResolver } from '@hookform/resolvers/zod';
import { useState } from 'react';
import { useForm } from 'react-hook-form';

import { useAuth } from '@/components/auth/auth-provider';
import { Markdown } from '@/components/markdown';
import { applyServerErrors } from '@/lib/form-errors';
import { useAddComment, useComments, useDeleteComment, useEditComment } from '@/lib/queries/issues';

import { Avatar } from './issue-badges';

interface CommentThreadProps {
  issue: { id: string; key: string };
  canComment: boolean;
  canModerate: boolean;
}

function CommentForm({
  id,
  label,
  initial = '',
  submitLabel,
  onSubmit,
  onCancel,
}: {
  id: string;
  label: string;
  initial?: string;
  submitLabel: string;
  onSubmit: (body: string) => Promise<unknown>;
  onCancel?: () => void;
}) {
  const [formError, setFormError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    reset,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<CreateCommentRequest>({
    resolver: zodResolver(CreateCommentRequest),
    defaultValues: { body: initial },
  });

  const submit = handleSubmit(async ({ body }) => {
    setFormError(null);
    try {
      await onSubmit(body);
      reset({ body: '' });
    } catch (error) {
      setFormError(applyServerErrors(error, setError, ['body']));
    }
  });

  return (
    <form onSubmit={(event) => void submit(event)} noValidate className="grid gap-2">
      {formError && <Alert variant="destructive">{formError}</Alert>}
      <Label htmlFor={id} className="sr-only">
        {label}
      </Label>
      <Textarea
        id={id}
        rows={3}
        placeholder="Write a comment… (Markdown supported)"
        aria-invalid={errors.body ? true : undefined}
        aria-describedby={errors.body ? `${id}-error` : undefined}
        {...register('body')}
      />
      {errors.body && (
        <p id={`${id}-error`} className="text-sm text-destructive">
          {errors.body.message}
        </p>
      )}
      <div className="flex justify-end gap-2">
        {onCancel && (
          <Button type="button" variant="outline" size="sm" onClick={onCancel}>
            Cancel
          </Button>
        )}
        <Button type="submit" size="sm" disabled={isSubmitting}>
          {isSubmitting ? 'Saving…' : submitLabel}
        </Button>
      </div>
    </form>
  );
}

function CommentItem({
  comment,
  canChange,
  onEdit,
  onDelete,
}: {
  comment: Comment;
  canChange: boolean;
  onEdit: (body: string) => Promise<unknown>;
  onDelete: () => Promise<unknown>;
}) {
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <li className="flex gap-3">
      <Avatar user={comment.author} size="md" />
      <div className="grid min-w-0 flex-1 gap-1">
        <p className="text-sm">
          <span className="font-medium">{comment.author.displayName}</span>{' '}
          <time dateTime={comment.createdAt} className="text-muted-foreground">
            {new Date(comment.createdAt).toLocaleString()}
          </time>
          {comment.editedAt && !comment.deleted && (
            <span className="text-muted-foreground"> · edited</span>
          )}
        </p>
        {comment.deleted ? (
          <p className="text-sm text-muted-foreground italic">This comment was deleted.</p>
        ) : editing ? (
          <CommentForm
            id={`comment-edit-${comment.id}`}
            label="Edit comment"
            initial={comment.body ?? ''}
            submitLabel="Save"
            onSubmit={async (body) => {
              await onEdit(body);
              setEditing(false);
            }}
            onCancel={() => {
              setEditing(false);
            }}
          />
        ) : (
          <>
            <Markdown>{comment.body ?? ''}</Markdown>
            {canChange && (
              <div className="flex gap-3 text-xs">
                <button
                  type="button"
                  className="text-muted-foreground hover:text-foreground hover:underline"
                  onClick={() => {
                    setEditing(true);
                  }}
                >
                  Edit
                </button>
                <button
                  type="button"
                  className="text-muted-foreground hover:text-destructive hover:underline"
                  onClick={() => {
                    if (!window.confirm('Delete this comment?')) return;
                    setError(null);
                    onDelete().catch((e: unknown) => {
                      setError(
                        e instanceof Error ? e.message : 'The comment could not be deleted.',
                      );
                    });
                  }}
                >
                  Delete
                </button>
              </div>
            )}
            {error && <p className="text-sm text-destructive">{error}</p>}
          </>
        )}
      </div>
    </li>
  );
}

export function CommentThread({ issue, canComment, canModerate }: CommentThreadProps) {
  const { state } = useAuth();
  const { data: comments, isPending, isError } = useComments(issue.id);
  const add = useAddComment(issue);
  const edit = useEditComment(issue);
  const remove = useDeleteComment(issue);

  return (
    <section aria-labelledby="comments-heading" className="grid gap-4">
      <h2 id="comments-heading" className="text-lg font-semibold">
        Comments{' '}
        {comments && comments.length > 0 && `(${comments.filter((c) => !c.deleted).length})`}
      </h2>
      {isPending ? (
        <p className="text-sm text-muted-foreground">Loading comments…</p>
      ) : isError ? (
        <Alert variant="destructive">Comments could not be loaded.</Alert>
      ) : comments.length === 0 ? (
        <p className="text-sm text-muted-foreground">No comments yet.</p>
      ) : (
        <ol className="grid gap-5">
          {comments.map((comment) => (
            <CommentItem
              key={comment.id}
              comment={comment}
              canChange={canComment && (comment.author.id === state.user?.id || canModerate)}
              onEdit={(body) => edit.mutateAsync({ id: comment.id, body })}
              onDelete={() => remove.mutateAsync(comment.id)}
            />
          ))}
        </ol>
      )}
      {canComment && (
        <CommentForm
          id="comment-new"
          label="Add a comment"
          submitLabel="Comment"
          onSubmit={(body) => add.mutateAsync(body)}
        />
      )}
    </section>
  );
}
