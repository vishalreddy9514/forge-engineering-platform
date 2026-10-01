import { z } from 'zod';

import { IssuePriority, IssueType } from './enums';

/**
 * AI assistant contracts (FR-7). Everything the model produces is validated against these
 * before the web app sees it, and is only ever a suggestion: nothing is saved until a person
 * saves it.
 */

export const DraftRequest = z.object({
  text: z
    .string()
    .trim()
    .min(10, 'Describe the problem or request in at least a sentence')
    .max(8000, 'Keep it under 8,000 characters'),
});
export type DraftRequest = z.infer<typeof DraftRequest>;

export const IssueDraft = z.object({
  title: z.string().min(3).max(200),
  description: z.string().max(10_000),
  acceptanceCriteria: z.array(z.string().min(1).max(500)).min(1).max(8),
  type: IssueType,
  priority: IssuePriority,
  priorityRationale: z.string().max(300),
  /** Only labels that exist in the project, in its spelling. */
  labels: z.array(z.string()).max(6),
  technicalArea: z.string().max(80),
});
export type IssueDraft = z.infer<typeof IssueDraft>;

/** Server-sent events of POST /projects/:id/ai/drafts. */
export const DraftStreamEvent = z.discriminatedUnion('event', [
  z.object({ event: z.literal('delta'), data: z.object({ text: z.string() }) }),
  z.object({
    event: z.literal('result'),
    data: z.object({ draft: IssueDraft, droppedLabels: z.array(z.string()) }),
  }),
  z.object({
    event: z.literal('error'),
    data: z.object({ code: z.string(), message: z.string() }),
  }),
]);
export type DraftStreamEvent = z.infer<typeof DraftStreamEvent>;

/** The description a draft becomes when applied to the create form. */
export function draftToDescription(draft: IssueDraft): string {
  const criteria = draft.acceptanceCriteria.map((c) => `- [ ] ${c}`).join('\n');
  return `${draft.description.trim()}\n\n## Acceptance criteria\n\n${criteria}`;
}

export const ThreadSummary = z.object({
  tldr: z.string().min(1),
  keyDecisions: z.array(z.string()),
  openQuestions: z.array(z.string()),
  nextSteps: z.array(z.string()),
});
export type ThreadSummary = z.infer<typeof ThreadSummary>;

export const IssueAiSummary = z.object({
  summary: ThreadSummary,
  generatedAt: z.string(),
  model: z.string(),
  promptVersion: z.string(),
  /** The issue or its comments changed after this summary was made. */
  stale: z.boolean(),
});
export type IssueAiSummary = z.infer<typeof IssueAiSummary>;

export const AiJobStatus = z.enum(['QUEUED', 'RUNNING', 'COMPLETED', 'FAILED']);
export type AiJobStatus = z.infer<typeof AiJobStatus>;

export const AiJob = z.object({
  id: z.uuid(),
  type: z.enum(['ISSUE_SUMMARY', 'PR_REVIEW', 'REINDEX']),
  status: AiJobStatus,
  error: z.string().nullable(),
  createdAt: z.string(),
  finishedAt: z.string().nullable(),
});
export type AiJob = z.infer<typeof AiJob>;

/** POST /issues/:id/ai/summaries: the cached summary if the thread is unchanged, else a job. */
export const SummaryRequested = z.discriminatedUnion('status', [
  z.object({ status: z.literal('completed'), summary: IssueAiSummary }),
  z.object({ status: z.literal('queued'), job: AiJob, statusUrl: z.string() }),
]);
export type SummaryRequested = z.infer<typeof SummaryRequested>;

export const AiStatus = z.object({
  /** False while the AI service is not configured or unreachable: AI features are hidden. */
  available: z.boolean(),
  budget: z.object({ used: z.number().int(), limit: z.number().int() }),
});
export type AiStatus = z.infer<typeof AiStatus>;
