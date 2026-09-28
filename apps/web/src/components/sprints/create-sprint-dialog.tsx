'use client';

import { CreateSprintRequest } from '@forge/types';
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
import { Textarea } from '@forge/ui/components/textarea';
import { zodResolver } from '@hookform/resolvers/zod';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import type { z } from 'zod';

import { FormField } from '@/components/forms/form-field';
import { applyServerErrors } from '@/lib/form-errors';
import { useCreateSprint } from '@/lib/queries/sprints';

type FormValues = z.input<typeof CreateSprintRequest>;

const addDays = (iso: string, days: number) =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

/** Suggests the next two-week slot after the latest sprint, named after the project. */
export function suggestSprint(
  projectKey: string,
  sprints: { name: string; endDate: string }[],
  today = new Date().toISOString().slice(0, 10),
): FormValues {
  const latestEnd = sprints
    .map((s) => s.endDate)
    .sort()
    .at(-1);
  const startDate = latestEnd && latestEnd >= today ? addDays(latestEnd, 1) : today;
  let n = sprints.length + 1;
  while (sprints.some((s) => s.name === `${projectKey} Sprint ${String(n)}`)) n++;
  return {
    name: `${projectKey} Sprint ${String(n)}`,
    goal: '',
    startDate,
    endDate: addDays(startDate, 13),
  };
}

export function CreateSprintDialog({
  projectId,
  defaults,
}: {
  projectId: string;
  defaults: FormValues;
}) {
  const create = useCreateSprint(projectId);
  const [open, setOpen] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    reset,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<FormValues, unknown, CreateSprintRequest>({
    resolver: zodResolver(CreateSprintRequest),
    values: defaults,
  });

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null);
    try {
      await create.mutateAsync({ ...values, goal: values.goal || undefined });
      setOpen(false);
      reset();
    } catch (error) {
      setFormError(applyServerErrors(error, setError, ['name', 'goal', 'startDate', 'endDate']));
    }
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <Plus aria-hidden="true" />
          New sprint
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogTitle>Plan a sprint</DialogTitle>
        <DialogDescription>Give it a goal the team can check its work against.</DialogDescription>
        <form onSubmit={(e) => void onSubmit(e)} noValidate className="grid gap-4">
          {formError && <Alert variant="destructive">{formError}</Alert>}
          <FormField
            id="sprint-name"
            label="Name"
            error={errors.name?.message}
            {...register('name')}
          />
          <div className="grid gap-2">
            <Label htmlFor="sprint-goal">Goal (optional)</Label>
            <Textarea id="sprint-goal" rows={2} {...register('goal')} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <FormField
              id="sprint-start"
              label="Start"
              type="date"
              error={errors.startDate?.message}
              {...register('startDate')}
            />
            <FormField
              id="sprint-end"
              label="End"
              type="date"
              error={errors.endDate?.message}
              {...register('endDate')}
            />
          </div>
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
              {isSubmitting ? 'Creating…' : 'Create sprint'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
