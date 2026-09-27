import {
  Commit,
  cursorPage,
  GithubInstallation,
  GithubIssue,
  GithubRepository,
  GithubStatus,
  type GithubIssueState,
  IssueDevelopment,
  LinkedRepository,
  PullRequest,
  type PullRequestState,
  SyncRequested,
} from '@forge/types';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';

import { apiFetch, apiJson } from '@/lib/api';

export const githubKeys = {
  status: ['github', 'status'] as const,
  installations: ['github', 'installations'] as const,
  project: (projectId: string) => ['github', 'project', projectId] as const,
  repositories: (projectId: string) => ['github', 'project', projectId, 'repositories'] as const,
  available: (projectId: string) => ['github', 'project', projectId, 'available'] as const,
  list: (projectId: string, kind: string, filters: object) =>
    ['github', 'project', projectId, kind, filters] as const,
  development: (issueId: string) => ['github', 'development', issueId] as const,
};

/** While a sync is queued or running, repository cards refresh until it settles. */
export const SYNC_POLL_MS = 3_000;

const post = (body?: unknown): RequestInit => ({
  method: 'POST',
  body: body === undefined ? undefined : JSON.stringify(body),
});

export function useGithubStatus() {
  return useQuery({
    queryKey: githubKeys.status,
    queryFn: () => apiJson('/github/status', GithubStatus),
    staleTime: 5 * 60_000,
  });
}

export function useInstallations(enabled: boolean) {
  return useQuery({
    queryKey: githubKeys.installations,
    queryFn: () => apiJson('/github/installations', z.array(GithubInstallation)),
    enabled,
  });
}

export function useClaimInstallation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (installationId: number) =>
      apiJson('/github/installations', GithubInstallation, post({ installationId })),
    onSettled: () => client.invalidateQueries({ queryKey: ['github'] }),
  });
}

export function useLinkedRepositories(projectId: string) {
  return useQuery({
    queryKey: githubKeys.repositories(projectId),
    queryFn: () => apiJson(`/projects/${projectId}/repositories`, z.array(LinkedRepository)),
    refetchInterval: (query) =>
      query.state.data?.some((r) => r.syncStatus === 'QUEUED' || r.syncStatus === 'RUNNING')
        ? SYNC_POLL_MS
        : false,
  });
}

export function useAvailableRepositories(projectId: string, enabled: boolean) {
  return useQuery({
    queryKey: githubKeys.available(projectId),
    queryFn: () =>
      apiJson(`/projects/${projectId}/github/available-repositories`, z.array(GithubRepository)),
    enabled,
  });
}

/** Linking, unlinking and syncing change what every GitHub view of the project shows. */
function useProjectGithubMutation<T, R>(projectId: string, fn: (arg: T) => Promise<R>) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSettled: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: githubKeys.project(projectId) }),
        client.invalidateQueries({ queryKey: ['github', 'development'] }),
      ]);
    },
  });
}

export const useLinkRepository = (projectId: string) =>
  useProjectGithubMutation(projectId, (repositoryId: string) =>
    apiJson(`/projects/${projectId}/repositories`, LinkedRepository, post({ repositoryId })),
  );

export const useUnlinkRepository = (projectId: string) =>
  useProjectGithubMutation(projectId, (repositoryId: string) =>
    apiFetch(`/projects/${projectId}/repositories/${repositoryId}`, { method: 'DELETE' }),
  );

export const useRequestSync = (projectId: string) =>
  useProjectGithubMutation(projectId, (repositoryId: string) =>
    apiJson(`/projects/${projectId}/repositories/${repositoryId}/sync`, SyncRequested, post()),
  );

interface ListFilters<S> {
  repositoryId?: string;
  state?: S;
}

function useProjectList<T extends z.ZodType, S extends string>(
  projectId: string,
  path: string,
  item: T,
  filters: ListFilters<S>,
) {
  const schema = cursorPage(item);
  return useInfiniteQuery({
    queryKey: githubKeys.list(projectId, path, filters),
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ limit: '20' });
      if (filters.repositoryId) params.set('repositoryId', filters.repositoryId);
      if (filters.state) params.set('state', filters.state);
      if (pageParam) params.set('cursor', pageParam);
      return apiJson(`/projects/${projectId}/${path}?${params.toString()}`, schema);
    },
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
  });
}

export const usePullRequests = (projectId: string, filters: ListFilters<PullRequestState>) =>
  useProjectList(projectId, 'pull-requests', PullRequest, filters);

export const useCommits = (projectId: string, filters: ListFilters<never>) =>
  useProjectList(projectId, 'commits', Commit, filters);

export const useGithubIssues = (projectId: string, filters: ListFilters<GithubIssueState>) =>
  useProjectList(projectId, 'github-issues', GithubIssue, filters);

export function useIssueDevelopment(issueId: string) {
  return useQuery({
    queryKey: githubKeys.development(issueId),
    queryFn: () => apiJson(`/issues/${issueId}/development`, IssueDevelopment),
  });
}
