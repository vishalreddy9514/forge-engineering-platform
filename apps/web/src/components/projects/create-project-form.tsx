'use client';

import { CreateProjectRequest } from '@forge/types';
import { Alert } from '@forge/ui/components/alert';
import { Button } from '@forge/ui/components/button';
import { Label } from '@forge/ui/components/label';
import { Textarea } from '@forge/ui/components/textarea';
import { zodResolver } from '@hookform/resolvers/zod';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import type { z } from 'zod';

import { FormField } from '@/components/forms/form-field';
import { applyServerErrors } from '@/lib/form-errors';
import { suggestProjectKey } from '@/lib/project-key';
import { useCreateProject } from '@/lib/queries/projects';

type FormValues = z.input<typeof CreateProjectRequest>;

export function CreateProjectForm() {
  const router = useRouter();
  const create = useCreateProject();
  const [formError, setFormError] = useState<string | null>(null);
  // Suggest a key from the name until the user types a key of their own.
  const [keyEdited, setKeyEdited] = useState(false);
  const {
    register,
    handleSubmit,
    setValue,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<FormValues, unknown, CreateProjectRequest>({
    resolver: zodResolver(CreateProjectRequest),
    defaultValues: { key: '', name: '', description: '' },
  });

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null);
    try {
      const project = await create.mutateAsync({
        ...values,
        description: values.description || undefined,
      });
      router.push(`/projects/${project.key}`);
    } catch (error) {
      setFormError(applyServerErrors(error, setError, ['key', 'name', 'description']));
    }
  });

  const nameField = register('name', {
    onChange: (e: { target: { value: string } }) => {
      if (!keyEdited) setValue('key', suggestProjectKey(e.target.value));
    },
  });
  const keyField = register('key', {
    onChange: () => {
      setKeyEdited(true);
    },
  });

  return (
    <form onSubmit={(event) => void onSubmit(event)} noValidate className="grid gap-5">
      {formError && <Alert variant="destructive">{formError}</Alert>}
      <FormField id="name" label="Project name" error={errors.name?.message} {...nameField} />
      <FormField
        id="key"
        label="Key"
        className="font-mono uppercase"
        maxLength={10}
        hint="Prefixes issue numbers, e.g. PAY-123. It cannot be changed later."
        error={errors.key?.message}
        {...keyField}
      />
      <div className="grid gap-2">
        <Label htmlFor="description">Description (optional)</Label>
        <Textarea id="description" rows={3} {...register('description')} />
      </div>
      <div className="flex gap-2">
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting ? 'Creating…' : 'Create project'}
        </Button>
        <Button
          type="button"
          variant="ghost"
          onClick={() => {
            router.back();
          }}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}
