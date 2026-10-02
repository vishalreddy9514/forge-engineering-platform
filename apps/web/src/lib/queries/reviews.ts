import { AiJob, PullRequestDetail, PullRequestReview, ReviewRequested } from '@forge/types';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { ApiError, apiJson } from '@/lib/api';
import { aiKeys, JOB_POLL_MS } from '@/lib/queries/ai';

export const reviewKeys = {
  pullRequest: (projectId: string, id: string) => ['pull-request', projectId, id] as const,
  review: (projectId: string, id: string) => ['pull-request', projectId, id, 'review'] as const,
  job: (jobId: string) => ['ai', 'review-job', jobId] as const,
};

const base = (projectId: string, id: string) => `/projects/${projectId}/pull-requests/${id}`;

export function usePullRequest(projectId: string, id: string) {
  return useQuery({
    queryKey: reviewKeys.pullRequest(projectId, id),
    queryFn: () => apiJson(base(projectId, id), PullRequestDetail),
  });
}

export function useReview(projectId: string, id: string) {
  return useQuery({
    queryKey: reviewKeys.review(projectId, id),
    queryFn: async () => {
      try {
        return await apiJson(`${base(projectId, id)}/ai/review`, PullRequestReview);
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return null; // not reviewed yet
        throw error;
      }
    },
  });
}

export function useRequestReview(projectId: string, id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiJson(`${base(projectId, id)}/ai/reviews`, ReviewRequested, { method: 'POST' }),
    onSuccess: async (result) => {
      if (result.status === 'completed') {
        client.setQueryData(reviewKeys.review(projectId, id), result.review);
      }
      await client.invalidateQueries({ queryKey: aiKeys.status });
    },
  });
}

/** Polls a review job until it finishes, then loads the review (it can take a minute). */
export function useReviewJob(jobId: string | null, projectId: string, id: string) {
  const client = useQueryClient();
  return useQuery({
    queryKey: reviewKeys.job(jobId ?? ''),
    queryFn: async () => {
      const job = await apiJson(`/ai/jobs/${jobId ?? ''}`, AiJob);
      if (job.status === 'COMPLETED') {
        await Promise.all([
          client.invalidateQueries({ queryKey: reviewKeys.review(projectId, id) }),
          client.invalidateQueries({ queryKey: reviewKeys.pullRequest(projectId, id) }),
        ]);
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
