'use client';

import { PasswordResetRequest } from '@forge/types';
import { Alert } from '@forge/ui/components/alert';
import { Button } from '@forge/ui/components/button';
import { zodResolver } from '@hookform/resolvers/zod';
import Link from 'next/link';
import { useState } from 'react';
import { useForm } from 'react-hook-form';

import { FormField } from '@/components/forms/form-field';
import { authApi } from '@/lib/auth-api';
import { applyServerErrors } from '@/lib/form-errors';

export function ForgotPasswordForm() {
  const [sent, setSent] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<PasswordResetRequest>({ resolver: zodResolver(PasswordResetRequest) });

  const onSubmit = handleSubmit(async ({ email }) => {
    setFormError(null);
    try {
      await authApi.requestPasswordReset(email);
      setSent(true);
    } catch (error) {
      setFormError(applyServerErrors(error, setError, ['email']));
    }
  });

  if (sent) {
    return (
      <div className="grid gap-4">
        <Alert variant="success">
          If an account exists for that email, we&apos;ve sent a link to reset the password. It
          expires in 30 minutes.
        </Alert>
        <Link href="/login" className="text-center text-sm underline-offset-4 hover:underline">
          Back to sign in
        </Link>
      </div>
    );
  }

  return (
    <form
      // POST, so a submit before hydration never puts the fields in the URL (ZAP 10024).
      method="post"
      onSubmit={(event) => void onSubmit(event)}
      noValidate
      className="grid gap-4"
    >
      {formError && <Alert variant="destructive">{formError}</Alert>}
      <FormField
        id="email"
        label="Email"
        type="email"
        autoComplete="email"
        error={errors.email?.message}
        {...register('email')}
      />
      <Button type="submit" disabled={isSubmitting}>
        {isSubmitting ? 'Sending…' : 'Send reset link'}
      </Button>
      <Link href="/login" className="text-center text-sm underline-offset-4 hover:underline">
        Back to sign in
      </Link>
    </form>
  );
}
