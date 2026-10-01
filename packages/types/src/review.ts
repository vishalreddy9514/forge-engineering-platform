import { z } from 'zod';

import { AiJob } from './ai';
import { PullRequest } from './github';

/**
 * AI code review of a pull request (FR-9). Suggestions only: shown with a banner, never posted
 * to GitHub by Forge, and never a substitute for human review.
 */

export const REVIEW_DISCLAIMER =
  'AI-generated suggestions. This does not replace human code review.';

export const ReviewSeverity = z.enum(['critical', 'major', 'minor', 'nit']);
export type ReviewSeverity = z.infer<typeof ReviewSeverity>;

export const ReviewCategory = z.enum([
  'bug',
  'security',
  'performance',
  'maintainability',
  'style',
  'testing',
]);
export type ReviewCategory = z.infer<typeof ReviewCategory>;

export const ReviewFinding = z.object({
  file: z.string(),
  /** Line in the new version of the file; null for a remark about the whole file. */
  line: z.number().int().nullable(),
  severity: ReviewSeverity,
  category: ReviewCategory,
  explanation: z.string(),
  suggestion: z.string(),
});
export type ReviewFinding = z.infer<typeof ReviewFinding>;

export const MissingTest = z.object({ description: z.string(), file: z.string().nullable() });
export type MissingTest = z.infer<typeof MissingTest>;

export const ReviewedFile = z.object({
  path: z.string(),
  status: z.enum(['reviewed', 'failed']),
  summary: z.string(),
  findings: z.number().int(),
});
export type ReviewedFile = z.infer<typeof ReviewedFile>;

/** A changed file that was not sent for review, and why (lockfile, generated, binary, budget…). */
export const SkippedFile = z.object({ path: z.string(), reason: z.string() });
export type SkippedFile = z.infer<typeof SkippedFile>;

export const PullRequestReview = z.object({
  id: z.uuid(),
  headSha: z.string(),
  summary: z.string(),
  findings: z.array(ReviewFinding),
  missingTests: z.array(MissingTest),
  files: z.array(ReviewedFile),
  skippedFiles: z.array(SkippedFile),
  model: z.string(),
  promptVersion: z.string(),
  createdAt: z.string(),
  /** The pull request has new commits since this review. */
  stale: z.boolean(),
});
export type PullRequestReview = z.infer<typeof PullRequestReview>;

export const PullRequestDetail = PullRequest.extend({
  body: z.string().nullable(),
  headSha: z.string(),
  additions: z.number().int().nullable(),
  deletions: z.number().int().nullable(),
  changedFiles: z.number().int().nullable(),
});
export type PullRequestDetail = z.infer<typeof PullRequestDetail>;

/** POST …/ai/reviews: the review of the current head if one exists, else a job. */
export const ReviewRequested = z.discriminatedUnion('status', [
  z.object({ status: z.literal('completed'), review: PullRequestReview }),
  z.object({ status: z.literal('queued'), job: AiJob, statusUrl: z.string() }),
]);
export type ReviewRequested = z.infer<typeof ReviewRequested>;

/** The review as Markdown, for a person to paste into GitHub themselves (FR-9.4, see ADR-0015). */
export function reviewToMarkdown(
  review: Pick<PullRequestReview, 'summary' | 'findings' | 'missingTests'>,
): string {
  const lines = ['## AI review', '', `> ${REVIEW_DISCLAIMER}`, '', review.summary, ''];
  if (review.findings.length > 0) {
    lines.push('### Findings', '');
    for (const f of review.findings) {
      const where = f.line === null ? f.file : `${f.file}:${String(f.line)}`;
      lines.push(`- **${f.severity}** (${f.category}) \`${where}\`: ${f.explanation}`);
      if (f.suggestion) lines.push(`  - Suggestion: ${f.suggestion}`);
    }
    lines.push('');
  }
  if (review.missingTests.length > 0) {
    lines.push('### Missing tests', '');
    for (const t of review.missingTests) {
      lines.push(`- ${t.description}${t.file ? ` (\`${t.file}\`)` : ''}`);
    }
    lines.push('');
  }
  return lines.join('\n').trimEnd() + '\n';
}
