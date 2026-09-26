import type { Metadata } from 'next';
import { Suspense } from 'react';

import { AuthCard } from '@/components/auth/auth-card';
import { LoginForm } from '@/components/auth/login-form';

export const metadata: Metadata = { title: 'Sign in' };

export default function LoginPage() {
  return (
    <AuthCard title="Sign in" description="Welcome back. Sign in to your workspace.">
      {/* useSearchParams (for ?next=) needs a Suspense boundary during static rendering. */}
      <Suspense>
        <LoginForm />
      </Suspense>
    </AuthCard>
  );
}
