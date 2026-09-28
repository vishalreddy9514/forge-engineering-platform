'use client';

import {
  CreateIssueRequest,
  IssuePriority,
  IssueType,
  PRIORITY_LABELS,
  TYPE_LABELS,
} from '@forge/types';
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
import { Textarea } from '@forge/ui/components/textarea';
import { zodResolver } from '@hookform/resolvers/zod';
import { Plus, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import type { z } from 'zod';

import { DraftAssistant, type DraftValues } from '@/components/ai/draft-assistant';
import { FormField } from '@/components/forms/form-field';
import { useCan, useCurrentProject } from '@/components/projects/project-context';
import { applyServerErrors } from '@/lib/form-errors';
import { useAiStatus } from '@/lib/queries/ai';
import { useCreateIssue } from '@/lib/queries/issues';
import { useLabels } from '@/lib/queries/projects';

type FormValues = z.input<typeof CreateIssueRequest>;

export function CreateIssueDialog() {
  const project = useCurrentProject();
  const router = useRouter();
  const create = useCreateIssue(project.id);
  const canUseAi = useCan('ai:write');
  const { data: aiStatus } = useAiStatus();
  const { data: labels = [] } = useLabels(project.id);
  const [open, setOpen] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    reset,
    setError,
    setValue,
    control,
    formState: { errors, isSubmitting },
  } = useForm<FormValues, unknown, CreateIssueRequest>({
    resolver: zodResolver(CreateIssueRequest),
    defaultValues: {
      title: '',
      description: '',
      type: 'TASK',
      priority: 'MEDIUM',
      status: 'BACKLOG',
      labelIds: [],
    },
  });
  const labelIds = useWatch({ control, name: 'labelIds' }) ?? [];

  const applyDraft = (draft: DraftValues) => {
    const options = { shouldDirty: true, shouldValidate: true };
    setValue('title', draft.title, options);
    setValue('description', draft.description, options);
    setValue('type', draft.type, options);
    setValue('priority', draft.priority, options);
    setValue('labelIds', draft.labelIds, options);
  };

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null);
    try {
      const issue = await create.mutateAsync({
        ...values,
        description: values.description || undefined,
      });
      setOpen(false);
      reset();
      router.push(`/projects/${project.key}/issues/${issue.key}`);
    } catch (error) {
      setFormError(applyServerErrors(error, setError, ['title', 'description']));
    }
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <Plus aria-hidden="true" />
          New issue
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] max-w-lg overflow-y-auto">
        <DialogTitle>New issue in {project.name}</DialogTitle>
        <DialogDescription>
          Describe the problem or the work. You can refine it later.
        </DialogDescription>
        <form onSubmit={(event) => void onSubmit(event)} noValidate className="grid gap-4">
          {formError && <Alert variant="destructive">{formError}</Alert>}
          {canUseAi && aiStatus?.available && (
            <DraftAssistant projectId={project.id} labels={labels} onApply={applyDraft} />
          )}
          <FormField
            id="issue-title"
            label="Title"
            error={errors.title?.message}
            {...register('title')}
          />
          <div className="grid gap-2">
            <Label htmlFor="issue-description">Description (Markdown)</Label>
            <Textarea id="issue-description" rows={5} {...register('description')} />
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div className="grid gap-2">
              <Label htmlFor="issue-type">Type</Label>
              <Select id="issue-type" {...register('type')}>
                {IssueType.options.map((t) => (
                  <option key={t} value={t}>
                    {TYPE_LABELS[t]}
                  </option>
                ))}
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="issue-priority">Priority</Label>
              <Select id="issue-priority" {...register('priority')}>
                {IssuePriority.options.map((p) => (
                  <option key={p} value={p}>
                    {PRIORITY_LABELS[p]}
                  </option>
                ))}
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="issue-status">Status</Label>
              <Select id="issue-status" {...register('status')}>
                <option value="BACKLOG">Backlog</option>
                <option value="TODO">To do</option>
              </Select>
            </div>
          </div>
          {labelIds.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5 text-sm">
              <span className="text-muted-foreground">Labels:</span>
              {labelIds.map((id) => (
                <span key={id} className="flex items-center gap-1 rounded-full border px-2 py-0.5">
                  {labels.find((l) => l.id === id)?.name ?? 'label'}
                  <button
                    type="button"
                    aria-label={`Remove label ${labels.find((l) => l.id === id)?.name ?? ''}`}
                    onClick={() => {
                      setValue(
                        'labelIds',
                        labelIds.filter((other) => other !== id),
                      );
                    }}
                  >
                    <X className="size-3" aria-hidden="true" />
                  </button>
                </span>
              ))}
            </div>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setOpen(false);
              }}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? 'Creating…' : 'Create issue'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
