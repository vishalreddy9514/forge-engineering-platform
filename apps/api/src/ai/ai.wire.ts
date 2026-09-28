import { IssueDraft, ThreadSummary } from '@forge/types';
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
