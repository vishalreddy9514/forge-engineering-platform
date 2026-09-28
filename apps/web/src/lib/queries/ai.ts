import {
  AiJob,
  AiStatus,
  DraftStreamEvent,
  type IssueDraft,
  IssueAiSummary,
  SummaryRequested,
} from '@forge/types';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiFetch, ApiError, apiJson } from '@/lib/api';
import { readSse } from '@/lib/sse';

export const aiKeys = {
  status: ['ai', 'status'] as const,
  summary: (issueId: string) => ['ai', 'summary', issueId] as const,
  job: (jobId: string) => ['ai', 'job', jobId] as const,
};

/** Polling interval for a queued or running AI job. */
export const JOB_POLL_MS = 2_000;

export function useAiStatus() {
  return useQuery({
    queryKey: aiKeys.status,
    queryFn: () => apiJson('/ai/status', AiStatus),
    staleTime: 30_000,
  });
}

export interface DraftOutcome {
  draft: IssueDraft;
  droppedLabels: string[];
}

/**
 * Streams an AI draft (FR-7.1): `onText` receives the model's output as it is written, and the
 * promise resolves with the validated draft. Rejects with the server's message on failure.
 */
export async function streamDraft(
  projectId: string,
  text: string,
  onText: (textSoFar: string) => void,
  signal?: AbortSignal,
): Promise<DraftOutcome> {
  const res = await apiFetch(`/projects/${projectId}/ai/drafts`, {
    method: 'POST',
    body: JSON.stringify({ text }),
    headers: { Accept: 'text/event-stream' },
    signal,
  });
  if (!res.body) throw new Error('The draft could not be generated. Please try again.');
  let soFar = '';
  for await (const raw of readSse(res.body)) {
    const data: unknown = JSON.parse(raw.data);
    const parsed = DraftStreamEvent.safeParse({ event: raw.event, data });
    if (!parsed.success) continue;
    const event = parsed.data;
    if (event.event === 'delta') {
      soFar += event.data.text;
      onText(soFar);
    } else if (event.event === 'result') {
      return event.data;
    } else {
      throw new Error(event.data.message);
    }
  }
  throw new Error('The draft was interrupted. Please try again.');
}

export function useIssueSummary(issueId: string) {
  return useQuery({
    queryKey: aiKeys.summary(issueId),
    queryFn: async () => {
      try {
        return await apiJson(`/issues/${issueId}/ai/summary`, IssueAiSummary);
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return null; // none yet
        throw error;
      }
    },
  });
}

export function useRequestSummary(issueId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiJson(`/issues/${issueId}/ai/summaries`, SummaryRequested, { method: 'POST' }),
    onSuccess: async (result) => {
      if (result.status === 'completed') {
        client.setQueryData(aiKeys.summary(issueId), result.summary);
      }
      await client.invalidateQueries({ queryKey: aiKeys.status });
    },
  });
}

/** Polls a summary job until it finishes, then refreshes the issue's summary. */
export function useAiJob(jobId: string | null, issueId: string) {
  const client = useQueryClient();
  return useQuery({
    queryKey: aiKeys.job(jobId ?? ''),
    queryFn: async () => {
      const job = await apiJson(`/ai/jobs/${jobId ?? ''}`, AiJob);
      if (job.status === 'COMPLETED') {
        await client.invalidateQueries({ queryKey: aiKeys.summary(issueId) });
      }
      return job;
    },
    enabled: jobId !== null,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === 'COMPLETED' || status === 'FAILED' ? false : JOB_POLL_MS;
    },
  });
}
