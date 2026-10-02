import { IssueDraft, MissingTest, ReviewedFile, ReviewFinding, ThreadSummary } from '@forge/types';
import { z } from 'zod';

/**
 * What the AI service sends back (apps/ai-service/app/api/features.py). Parsed, never trusted:
 * a response that does not match is a failure, not something to pass on. The shapes are pinned
 * by golden files the Python tests produce (apps/ai-service/tests/contract), which the spec for
 * this file parses.
 */

export const WireUsage = z.object({
  inputTokens: z.number().int().min(0),
  outputTokens: z.number().int().min(0),
  /** Decimal string, e.g. "0.000412". */
  costUsd: z.string().regex(/^\d+(\.\d+)?$/),
});
export type WireUsage = z.infer<typeof WireUsage>;

export const DraftResult = z.object({
  draft: IssueDraft,
  droppedLabels: z.array(z.string()),
  model: z.string(),
  promptVersion: z.string(),
  repaired: z.boolean(),
  usage: WireUsage,
});
export type DraftResult = z.infer<typeof DraftResult>;

export const DraftError = z.object({
  code: z.string(),
  message: z.string(),
  model: z.string(),
  usage: WireUsage,
});
export type DraftError = z.infer<typeof DraftError>;

export const SummaryResponse = z.object({
  summary: ThreadSummary,
  model: z.string(),
  promptVersion: z.string(),
  repaired: z.boolean(),
  omittedComments: z.number().int().min(0),
  usage: WireUsage,
});
export type SummaryResponse = z.infer<typeof SummaryResponse>;

// ───────────────────────────── Retrieval (apps/ai-service/app/api/rag.py) ─────────────

export const WireEmbeddingUsage = z.object({
  model: z.string(),
  inputTokens: z.number().int().min(0),
  costUsd: z.string().regex(/^\d+(\.\d+)?$/),
});
export type WireEmbeddingUsage = z.infer<typeof WireEmbeddingUsage>;

const SourceType = z.enum(['ISSUE', 'COMMENT', 'PULL_REQUEST', 'COMMIT', 'UPLOAD']);

export const IndexResponse = z.object({
  status: z.enum(['indexed', 'unchanged', 'stale', 'missing', 'rejected']),
  chunks: z.number().int().min(0),
  embedded: z.number().int().min(0),
  reused: z.number().int().min(0),
  embedding: WireEmbeddingUsage,
  detail: z.string().nullable().optional(),
});
export type IndexResponse = z.infer<typeof IndexResponse>;

export const SearchResponse = z.object({
  results: z.array(
    z.object({
      documentId: z.uuid(),
      projectId: z.uuid(),
      sourceType: SourceType,
      sourceId: z.uuid().nullable(),
      title: z.string(),
      url: z.string(),
      headingPath: z.string().nullable(),
      snippet: z.string(),
      score: z.number(),
      vectorRank: z.number().int().nullable(),
      keywordRank: z.number().int().nullable(),
    }),
  ),
  embedding: WireEmbeddingUsage,
});
export type SearchResponse = z.infer<typeof SearchResponse>;

export const RelatedResponse = z.object({
  results: z.array(
    z.object({
      issueId: z.uuid(),
      documentId: z.uuid(),
      title: z.string(),
      url: z.string(),
      score: z.number(),
    }),
  ),
  threshold: z.number(),
  embedding: WireEmbeddingUsage,
});
export type RelatedResponse = z.infer<typeof RelatedResponse>;

const ChatUsage = z.object({
  model: z.string(),
  promptVersion: z.string(),
  usage: WireUsage,
  embedding: WireEmbeddingUsage,
});

export const WireCitation = z.object({
  n: z.number().int().min(1),
  sourceType: SourceType,
  sourceId: z.uuid().nullable(),
  documentId: z.uuid().nullable(),
  projectId: z.uuid(),
  title: z.string(),
  url: z.string(),
  headingPath: z.string().nullable(),
});
export type WireCitation = z.infer<typeof WireCitation>;

export const ChatResultEvent = ChatUsage.extend({
  answer: z.string(),
  citations: z.array(WireCitation),
});
export type ChatResultEvent = z.infer<typeof ChatResultEvent>;

export const ChatToolCallEvent = ChatUsage.extend({
  id: z.string().min(1).max(100),
  name: z.string(),
  /** The model's arguments: validated again by the API before anything runs (QueryIssuesArgs). */
  arguments: z.record(z.string(), z.unknown()),
  rawArguments: z.string().max(2000),
});
export type ChatToolCallEvent = z.infer<typeof ChatToolCallEvent>;

export const ChatErrorEvent = z.object({ code: z.string(), message: z.string() });

/** query_issues arguments as the tool schema defines them (apps/ai-service/app/rag/answer.py). */
export const QueryIssuesArgs = z.object({
  project_key: z.string().max(10),
  type: z.enum(['BUG', 'FEATURE', 'TASK', 'CHORE']).nullable(),
  status: z.enum(['open', 'in_progress', 'done']).nullable(),
  priority: z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']).nullable(),
  sprint: z.enum(['active', 'last_completed']).nullable(),
  updated_within_days: z.number().int().min(1).max(365).nullable(),
});
export type QueryIssuesArgs = z.infer<typeof QueryIssuesArgs>;

// ───────────────────────────── Code review (apps/ai-service/app/api/features.py) ───────────

export const ReviewResponse = z.object({
  summary: z.string(),
  findings: z.array(ReviewFinding),
  missingTests: z.array(MissingTest),
  files: z.array(ReviewedFile),
  model: z.string(),
  promptVersion: z.string(),
  calls: z.number().int().min(0),
  usage: WireUsage,
});
export type ReviewResponse = z.infer<typeof ReviewResponse>;

export interface ReviewInput {
  pullRequest: { number: number; title: string; body: string | null; repository: string };
  files: {
    path: string;
    status: 'added' | 'modified' | 'renamed' | 'copied' | 'changed';
    additions: number;
    deletions: number;
    patch: string;
  }[];
  omittedFiles: { path: string; reason: string }[];
}
