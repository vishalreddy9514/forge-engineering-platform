import {
  Burndown,
  type CompleteSprintRequest,
  type CreateSprintRequest,
  Sprint,
  Velocity,
} from '@forge/types';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';

import { apiFetch, apiJson } from '@/lib/api';

import { projectKeys } from './projects';

export const sprintKeys = {
  all: (projectId: string) => ['sprints', projectId] as const,
  list: (projectId: string) => ['sprints', projectId, 'list'] as const,
  burndown: (projectId: string, sprintId: string) =>
    ['sprints', projectId, 'burndown', sprintId] as const,
  velocity: (projectId: string) => ['sprints', projectId, 'velocity'] as const,
};

const CompletionSummary = z.object({
  sprint: Sprint,
  completed: z.number(),
  movedToBacklog: z.number(),
  movedToSprint: z.number(),
});

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  body: body === undefined ? undefined : JSON.stringify(body),
});

export function useSprints(projectId: string) {
  return useQuery({
    queryKey: sprintKeys.list(projectId),
    queryFn: () => apiJson(`/projects/${projectId}/sprints`, z.array(Sprint)),
  });
}

export function useBurndown(projectId: string, sprintId: string | undefined) {
  return useQuery({
    queryKey: sprintKeys.burndown(projectId, sprintId ?? ''),
    queryFn: () => apiJson(`/sprints/${sprintId ?? ''}/burndown`, Burndown),
    enabled: Boolean(sprintId),
  });
}

export function useVelocity(projectId: string) {
  return useQuery({
    queryKey: sprintKeys.velocity(projectId),
    queryFn: () => apiJson(`/projects/${projectId}/velocity?sprints=6`, Velocity),
  });
}

/**
 * Sprint changes touch the sprint list, reports, issue lists (sprint column and filters) and
 * the project header (active sprint), so all of them refresh after any change.
 */
function useSprintMutation<T, R>(projectId: string, fn: (arg: T) => Promise<R>) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSettled: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: sprintKeys.all(projectId) }),
        client.invalidateQueries({ queryKey: ['issues'] }),
        client.invalidateQueries({ queryKey: projectKeys.all }),
      ]);
    },
  });
}

export const useCreateSprint = (projectId: string) =>
  useSprintMutation(projectId, (body: CreateSprintRequest) =>
    apiJson(`/projects/${projectId}/sprints`, Sprint, json('POST', body)),
  );

export const useStartSprint = (projectId: string) =>
  useSprintMutation(projectId, (sprintId: string) =>
    apiJson(`/sprints/${sprintId}/start`, Sprint, json('POST')),
  );

export const useCompleteSprint = (projectId: string) =>
  useSprintMutation(
    projectId,
    ({ sprintId, ...body }: { sprintId: string } & CompleteSprintRequest) =>
      apiJson(`/sprints/${sprintId}/complete`, CompletionSummary, json('POST', body)),
  );

export const useDeleteSprint = (projectId: string) =>
  useSprintMutation(projectId, (sprintId: string) =>
    apiFetch(`/sprints/${sprintId}`, { method: 'DELETE' }),
  );

export const useAddToSprint = (projectId: string) =>
  useSprintMutation(projectId, ({ sprintId, issueIds }: { sprintId: string; issueIds: string[] }) =>
    apiJson(`/sprints/${sprintId}/issues`, Sprint, json('POST', { issueIds })),
  );

export const useRemoveFromSprint = (projectId: string) =>
  useSprintMutation(projectId, ({ sprintId, issueId }: { sprintId: string; issueId: string }) =>
    apiFetch(`/sprints/${sprintId}/issues/${issueId}`, { method: 'DELETE' }),
  );
