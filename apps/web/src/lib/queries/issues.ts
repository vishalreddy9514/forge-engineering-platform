import {
  Comment,
  type CreateIssueRequest,
  cursorPage,
  IssueDetail,
  IssueEvent,
  IssueSummary,
  type UpdateIssueRequest,
} from '@forge/types';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';

import { aiKeys } from '@/lib/queries/ai';
import { apiFetch, apiJson } from '@/lib/api';

export interface IssueFilters {
  status?: string[];
  priority?: string[];
  type?: string[];
  assignee?: string;
  label?: string;
  /** A sprint id, "active", or "none" (the backlog). */
  sprint?: string;
  q?: string;
  sort?: 'updated' | 'created' | 'priority';
  limit?: number;
}

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  body: body === undefined ? undefined : JSON.stringify(body),
});

export const issueKeys = {
  lists: (projectId: string) => ['issues', projectId, 'list'] as const,
  list: (projectId: string, filters: IssueFilters) =>
    ['issues', projectId, 'list', filters] as const,
  byKey: (key: string) => ['issues', 'by-key', key.toUpperCase()] as const,
  events: (issueId: string) => ['issues', issueId, 'events'] as const,
  comments: (issueId: string) => ['issues', issueId, 'comments'] as const,
};

const IssuePage = cursorPage(IssueSummary);

export function toSearchParams(filters: IssueFilters): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (Array.isArray(value)) {
      if (value.length > 0) params.set(key, value.join(','));
    } else if (value !== undefined && value !== '') {
      params.set(key, String(value));
    }
  }
  return params.toString();
}

export function useIssues(projectId: string, filters: IssueFilters) {
  return useQuery({
    queryKey: issueKeys.list(projectId, filters),
    queryFn: () =>
      apiJson(
        `/projects/${projectId}/issues?${toSearchParams({ limit: 100, ...filters })}`,
        IssuePage,
      ),
    placeholderData: keepPreviousData,
  });
}

export function useIssue(key: string) {
  return useQuery({
    queryKey: issueKeys.byKey(key),
    queryFn: () => apiJson(`/issues/by-key/${encodeURIComponent(key)}`, IssueDetail),
    retry: false,
  });
}

export function useCreateIssue(projectId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: Partial<CreateIssueRequest> & { title: string }) =>
      apiJson(`/projects/${projectId}/issues`, IssueDetail, json('POST', body)),
    onSuccess: (issue) => {
      client.setQueryData(issueKeys.byKey(issue.key), issue);
      void client.invalidateQueries({ queryKey: issueKeys.lists(projectId) });
    },
  });
}

/**
 * Sends the version the user last saw. On 409 (someone else changed the issue) the cache is
 * refreshed so the next attempt starts from the latest data; the caller shows the message.
 */
export function useUpdateIssue(issue: { id: string; key: string; projectId: string }) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateIssueRequest) =>
      apiJson(`/issues/${issue.id}`, IssueDetail, json('PATCH', body)),
    onSuccess: (updated) => {
      client.setQueryData(issueKeys.byKey(updated.key), updated);
      void client.invalidateQueries({ queryKey: issueKeys.lists(issue.projectId) });
      void client.invalidateQueries({ queryKey: issueKeys.events(issue.id) });
      // Title, description and status are part of what an AI summary was made from.
      void client.invalidateQueries({ queryKey: aiKeys.summary(issue.id) });
    },
    onError: () => client.invalidateQueries({ queryKey: issueKeys.byKey(issue.key) }),
  });
}

export function useDeleteIssue(issue: { id: string; projectId: string }) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch(`/issues/${issue.id}`, { method: 'DELETE' }),
    onSuccess: () => client.invalidateQueries({ queryKey: issueKeys.lists(issue.projectId) }),
  });
}

export function useIssueEvents(issueId: string) {
  return useQuery({
    queryKey: issueKeys.events(issueId),
    queryFn: () => apiJson(`/issues/${issueId}/events`, z.array(IssueEvent)),
  });
}

export function useComments(issueId: string) {
  return useQuery({
    queryKey: issueKeys.comments(issueId),
    queryFn: () => apiJson(`/issues/${issueId}/comments`, z.array(Comment)),
  });
}

function useCommentMutation<T>(issue: { id: string; key: string }, fn: (v: T) => Promise<unknown>) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: issueKeys.comments(issue.id) });
      void client.invalidateQueries({ queryKey: issueKeys.events(issue.id) });
      void client.invalidateQueries({ queryKey: issueKeys.byKey(issue.key) });
      // A comment changes the thread, so an existing AI summary may now be out of date.
      void client.invalidateQueries({ queryKey: aiKeys.summary(issue.id) });
    },
  });
}

export const useAddComment = (issue: { id: string; key: string }) =>
  useCommentMutation(issue, (body: string) =>
    apiJson(`/issues/${issue.id}/comments`, Comment, json('POST', { body })),
  );

export const useEditComment = (issue: { id: string; key: string }) =>
  useCommentMutation(issue, ({ id, body }: { id: string; body: string }) =>
    apiJson(`/comments/${id}`, Comment, json('PATCH', { body })),
  );

export const useDeleteComment = (issue: { id: string; key: string }) =>
  useCommentMutation(issue, (commentId: string) =>
    apiFetch(`/comments/${commentId}`, { method: 'DELETE' }),
  );

/** Board moves: one mutation for any card, carrying that card's version. */
export function useMoveIssue(projectId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ issue, status }: { issue: IssueSummary; status: IssueSummary['status'] }) =>
      apiJson(
        `/issues/${issue.id}`,
        IssueDetail,
        json('PATCH', { version: issue.version, status }),
      ),
    onSettled: () => client.invalidateQueries({ queryKey: issueKeys.lists(projectId) }),
  });
}
