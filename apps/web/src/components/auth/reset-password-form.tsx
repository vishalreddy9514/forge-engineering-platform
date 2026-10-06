'use client';

import { Password } from '@forge/types';
import { Alert } from '@forge/ui/components/alert';
import { Button } from '@forge/ui/components/button';
import { zodResolver } from '@hookform/resolvers/zod';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

import { FormField } from '@/components/forms/form-field';
import { authApi } from '@/lib/auth-api';
import { applyServerErrors } from '@/lib/form-errors';

const ResetForm = z
  .object({ newPassword: Password, confirmPassword: z.string() })
  .refine((v) => v.newPassword === v.confirmPassword, {
    path: ['confirmPassword'],
    message: 'Passwords do not match',
  });
type ResetForm = z.infer<typeof ResetForm>;

export function ResetPasswordForm() {
  const params = useSearchParams();
  // Read the token once, then drop it from the address bar so it does not linger in browser
  // history (or leak through Referer on later requests).
  const [token] = useState(() => params.get('token'));
  useEffect(() => {
    if (params.has('token')) window.history.replaceState(null, '', '/reset-password');
  }, [params]);
  const [done, setDone] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<ResetForm>({ resolver: zodResolver(ResetForm) });

  if (!token) {
    return <Alert variant="destructive">This reset link is incomplete. Request a new one.</Alert>;
  }

  if (done) {
    return (
      <div className="grid gap-4">
        <Alert variant="success">Your password has been changed. You can sign in now.</Alert>
        <Button asChild>
          <Link href="/login">Sign in</Link>
        </Button>
      </div>
    );
  }

  const onSubmit = handleSubmit(async ({ newPassword }) => {
    setFormError(null);
    try {
      await authApi.confirmPasswordReset({ token, newPassword });
      setDone(true);
    } catch (error) {
      setFormError(applyServerErrors(error, setError, ['newPassword']));
    }
  });

  return (
    <form
      // POST, so a submit before hydration never puts the fields in the URL (ZAP 10024).
      method="post"
      onSubmit={(event) => void onSubmit(event)}
      noValidate
      className="grid gap-4"
    >
      {formError && (
        <Alert variant="destructive">
          {formError}{' '}
          <Link href="/forgot-password" className="underline">
            Request a new link
          </Link>
        </Alert>
      )}
      <FormField
        id="newPassword"
        label="New password"
        type="password"
        autoComplete="new-password"
        error={errors.newPassword?.message}
        {...register('newPassword')}
      />
      <FormField
        id="confirmPassword"
        label="Confirm new password"
        type="password"
        autoComplete="new-password"
        error={errors.confirmPassword?.message}
        {...register('confirmPassword')}
      />
      <Button type="submit" disabled={isSubmitting}>
        {isSubmitting ? 'Saving…' : 'Set new password'}
      </Button>
    </form>
  );
}
