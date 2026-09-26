import type { PasswordResetEmailJob } from './email.jobs';

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** Display names are user input; never interpolate them into HTML unescaped. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ESCAPES[char] ?? char);
}

export function renderPasswordReset(job: PasswordResetEmailJob): RenderedEmail {
  const name = escapeHtml(job.displayName);
  const url = escapeHtml(job.resetUrl);
  return {
    subject: 'Reset your Forge password',
    text: [
      `Hi ${job.displayName},`,
      '',
      'Someone asked to reset the password for your Forge account.',
      `Use this link within ${job.expiresInMinutes} minutes to choose a new one:`,
      '',
      job.resetUrl,
      '',
      "If you didn't ask for this, you can ignore this email. Your password won't change.",
    ].join('\n'),
    html: `<p>Hi ${name},</p>
<p>Someone asked to reset the password for your Forge account.
Use this link within ${job.expiresInMinutes} minutes to choose a new one:</p>
<p><a href="${url}">Reset your password</a></p>
<p>If you didn't ask for this, you can ignore this email. Your password won't change.</p>`,
  };
}
