/** Job payloads on the email queue. Rendering happens in the worker, not the API. */
export interface PasswordResetEmailJob {
  to: string;
  displayName: string;
  resetUrl: string;
  expiresInMinutes: number;
}

export interface IssueAssignedEmailJob {
  to: string;
  displayName: string;
  actorName: string;
  issueKey: string;
  issueTitle: string;
  issueUrl: string;
}

export const EMAIL_JOBS = {
  PASSWORD_RESET: 'password-reset',
  ISSUE_ASSIGNED: 'issue-assigned',
} as const;
