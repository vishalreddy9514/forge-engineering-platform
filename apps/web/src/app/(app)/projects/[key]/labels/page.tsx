'use client';

import { CreateLabelRequest, type Label as LabelDto } from '@forge/types';
import { Alert } from '@forge/ui/components/alert';
import { Button } from '@forge/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@forge/ui/components/card';
import { Input } from '@forge/ui/components/input';
import { Label } from '@forge/ui/components/label';
import { Skeleton } from '@forge/ui/components/skeleton';
import { zodResolver } from '@hookform/resolvers/zod';
import { useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import type { z } from 'zod';

import { ConfirmDialog } from '@/components/confirm-dialog';
import { FormField } from '@/components/forms/form-field';
import { useCan, useCurrentProject } from '@/components/projects/project-context';
import { applyServerErrors } from '@/lib/form-errors';
import { useCreateLabel, useDeleteLabel, useLabels, useUpdateLabel } from '@/lib/queries/projects';

type LabelValues = z.input<typeof CreateLabelRequest>;

function Swatch({ color }: { color: string }) {
  return (
    <span
      aria-hidden="true"
      className="inline-block size-3.5 shrink-0 rounded-full border"
      style={{ backgroundColor: color }}
    />
  );
}

export default function LabelsPage() {
  const project = useCurrentProject();
  const canEdit = useCan('project:update');
  const { data: labels, isPending } = useLabels(project.id);

  return (
    <div className="grid gap-6">
      {canEdit && <LabelForm projectId={project.id} />}
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>Labels</h2>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {isPending && <Skeleton className="h-24" />}
          {labels?.length === 0 && <p className="text-sm text-muted-foreground">No labels yet.</p>}
          <ul className="divide-y" aria-label="Labels">
            {labels?.map((label) => (
              <LabelRow key={label.id} label={label} canEdit={canEdit} />
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}

function LabelRow({ label, canEdit }: { label: LabelDto; canEdit: boolean }) {
  const project = useCurrentProject();
  const [editing, setEditing] = useState(false);
  const remove = useDeleteLabel(project.id);

  if (editing) {
    return (
      <li className="py-3">
        <LabelForm
          projectId={project.id}
          label={label}
          onDone={() => {
            setEditing(false);
          }}
        />
      </li>
    );
  }
  return (
    <li className="flex items-center justify-between gap-3 py-3">
      <div className="flex items-center gap-3">
        <Swatch color={label.color} />
        <span className="font-medium">{label.name}</span>
        {label.description && (
          <span className="text-sm text-muted-foreground">{label.description}</span>
        )}
      </div>
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        {label.issueCount} {label.issueCount === 1 ? 'issue' : 'issues'}
        {canEdit && (
          <>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setEditing(true);
              }}
            >
              Edit
            </Button>
            <ConfirmDialog
              title={`Delete "${label.name}"?`}
              description={
                label.issueCount > 0
                  ? `It will be removed from ${label.issueCount} issue(s).`
                  : 'No issues use this label.'
              }
              confirmLabel="Delete label"
              destructive
              onConfirm={() => remove.mutateAsync(label.id)}
              trigger={(open) => (
                <Button variant="ghost" size="sm" onClick={open}>
                  Delete
                </Button>
              )}
            />
          </>
        )}
      </div>
    </li>
  );
}

/** Creates a label, or edits `label` when given. */
function LabelForm({
  projectId,
  label,
  onDone,
}: {
  projectId: string;
  label?: LabelDto;
  onDone?: () => void;
}) {
  const create = useCreateLabel(projectId);
  const update = useUpdateLabel(projectId);
  const [formError, setFormError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    reset,
    setError,
    control,
    formState: { errors, isSubmitting },
  } = useForm<LabelValues, unknown, CreateLabelRequest>({
    resolver: zodResolver(CreateLabelRequest),
    defaultValues: {
      name: label?.name ?? '',
      color: label?.color ?? '#1d76db',
      description: label?.description ?? '',
    },
  });

  const color = useWatch({ control, name: 'color' });

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null);
    const body = { ...values, description: values.description || undefined };
    try {
      if (label) await update.mutateAsync({ id: label.id, ...body });
      else await create.mutateAsync(body);
      reset(label ? values : { name: '', color: values.color, description: '' });
      onDone?.();
    } catch (error) {
      setFormError(applyServerErrors(error, setError, ['name', 'color', 'description']));
    }
  });

  const form = (
    <form
      onSubmit={(event) => void onSubmit(event)}
      noValidate
      className="grid gap-4 sm:grid-cols-[1fr_auto_1fr_auto] sm:items-start"
    >
      {formError && (
        <Alert variant="destructive" className="sm:col-span-4">
          {formError}
        </Alert>
      )}
      <FormField
        id={`label-name-${label?.id ?? 'new'}`}
        label="Name"
        error={errors.name?.message}
        {...register('name')}
      />
      <div className="grid gap-2">
        <Label htmlFor={`label-color-${label?.id ?? 'new'}`}>Colour</Label>
        <div className="flex items-center gap-2">
          <Swatch color={color} />
          <Input
            id={`label-color-${label?.id ?? 'new'}`}
            type="color"
            className="h-9 w-14 p-1"
            {...register('color')}
          />
        </div>
        {errors.color && <p className="text-sm text-destructive">{errors.color.message}</p>}
      </div>
      <FormField
        id={`label-description-${label?.id ?? 'new'}`}
        label="Description (optional)"
        {...register('description')}
      />
      <div className="flex gap-2 sm:mt-[1.375rem]">
        <Button type="submit" disabled={isSubmitting}>
          {label ? 'Save' : 'Add label'}
        </Button>
        {onDone && (
          <Button type="button" variant="ghost" onClick={onDone}>
            Cancel
          </Button>
        )}
      </div>
    </form>
  );

  if (label) return form;
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>New label</h2>
        </CardTitle>
      </CardHeader>
      <CardContent>{form}</CardContent>
    </Card>
  );
}
