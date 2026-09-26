/** Job payloads on the email queue. Rendering happens in the worker, not the API. */
export interface PasswordResetEmailJob {
  to: string;
  displayName: string;
  resetUrl: string;
  expiresInMinutes: number;
}

export const EMAIL_JOBS = { PASSWORD_RESET: 'password-reset' } as const;
