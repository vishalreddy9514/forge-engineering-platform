import {
  type AddMemberRequest,
  type CreateLabelRequest,
  type CreateProjectRequest,
  cursorPage,
  Label,
  type ProjectRole,
  ProjectDetail,
  ProjectMember,
  ProjectSummary,
  type UpdateLabelRequest,
  type UpdateProjectRequest,
} from '@forge/types';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';

import { apiFetch, apiJson } from '@/lib/api';

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  body: body === undefined ? undefined : JSON.stringify(body),
});

/** Query keys in one place, so mutations invalidate exactly what they change. */
export const projectKeys = {
  all: ['projects'] as const,
  list: (params: { q?: string; archived: boolean }) => ['projects', 'list', params] as const,
  byKey: (key: string) => ['projects', 'by-key', key.toUpperCase()] as const,
  members: (projectId: string) => ['projects', projectId, 'members'] as const,
  labels: (projectId: string) => ['projects', projectId, 'labels'] as const,
};

const ProjectPage = cursorPage(ProjectSummary);

export function useProjects(params: { q?: string; archived: boolean }) {
  return useQuery({
    queryKey: projectKeys.list(params),
    queryFn: () => {
      const search = new URLSearchParams({ limit: '100', archived: String(params.archived) });
      if (params.q) search.set('q', params.q);
      return apiJson(`/projects?${search.toString()}`, ProjectPage);
    },
    placeholderData: keepPreviousData,
  });
}

export function useProject(key: string) {
  return useQuery({
    queryKey: projectKeys.byKey(key),
    queryFn: () => apiJson(`/projects/by-key/${encodeURIComponent(key)}`, ProjectDetail),
    retry: false,
  });
}

export function useCreateProject() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateProjectRequest) =>
      apiJson('/projects', ProjectDetail, json('POST', body)),
    onSuccess: (project) => {
      client.setQueryData(projectKeys.byKey(project.key), project);
      void client.invalidateQueries({ queryKey: ['projects', 'list'] });
    },
  });
}

/** Keeps the cached project in sync after any mutation that returns the new state. */
function useProjectMutation<TVariables>(fn: (variables: TVariables) => Promise<ProjectDetail>) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (project) => {
      client.setQueryData(projectKeys.byKey(project.key), project);
      void client.invalidateQueries({ queryKey: ['projects', 'list'] });
    },
  });
}

export const useUpdateProject = (projectId: string) =>
  useProjectMutation((body: UpdateProjectRequest) =>
    apiJson(`/projects/${projectId}`, ProjectDetail, json('PATCH', body)),
  );

export const useSetArchived = (projectId: string) =>
  useProjectMutation((archived: boolean) =>
    apiJson(
      `/projects/${projectId}/${archived ? 'archive' : 'restore'}`,
      ProjectDetail,
      json('POST'),
    ),
  );

export function useDeleteProject(projectId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (confirmKey: string) =>
      apiFetch(`/projects/${projectId}?confirm=${encodeURIComponent(confirmKey)}`, {
        method: 'DELETE',
      }),
    onSuccess: () => client.invalidateQueries({ queryKey: projectKeys.all }),
  });
}

// ───────────── Members ─────────────

export function useMembers(projectId: string | undefined) {
  return useQuery({
    queryKey: projectKeys.members(projectId ?? ''),
    queryFn: () => apiJson(`/projects/${projectId ?? ''}/members`, z.array(ProjectMember)),
    enabled: Boolean(projectId),
  });
}

function useMembersMutation<TVariables>(
  projectId: string,
  fn: (variables: TVariables) => Promise<unknown>,
) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: projectKeys.members(projectId) });
      // Member counts on project cards and the detail header change too.
      void client.invalidateQueries({ queryKey: ['projects', 'by-key'] });
      void client.invalidateQueries({ queryKey: ['projects', 'list'] });
    },
  });
}

export const useAddMember = (projectId: string) =>
  useMembersMutation(projectId, (body: AddMemberRequest) =>
    apiJson(`/projects/${projectId}/members`, ProjectMember, json('POST', body)),
  );

export const useChangeRole = (projectId: string) =>
  useMembersMutation(projectId, ({ userId, role }: { userId: string; role: ProjectRole }) =>
    apiJson(`/projects/${projectId}/members/${userId}`, ProjectMember, json('PATCH', { role })),
  );

export const useRemoveMember = (projectId: string) =>
  useMembersMutation(projectId, (userId: string) =>
    apiFetch(`/projects/${projectId}/members/${userId}`, { method: 'DELETE' }),
  );

// ───────────── Labels ─────────────

export function useLabels(projectId: string | undefined) {
  return useQuery({
    queryKey: projectKeys.labels(projectId ?? ''),
    queryFn: () => apiJson(`/projects/${projectId ?? ''}/labels`, z.array(Label)),
    enabled: Boolean(projectId),
  });
}

function useLabelsMutation<TVariables>(projectId: string, fn: (v: TVariables) => Promise<unknown>) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => client.invalidateQueries({ queryKey: projectKeys.labels(projectId) }),
  });
}

export const useCreateLabel = (projectId: string) =>
  useLabelsMutation(projectId, (body: CreateLabelRequest) =>
    apiJson(`/projects/${projectId}/labels`, Label, json('POST', body)),
  );

export const useUpdateLabel = (projectId: string) =>
  useLabelsMutation(projectId, ({ id, ...body }: UpdateLabelRequest & { id: string }) =>
    apiJson(`/labels/${id}`, Label, json('PATCH', body)),
  );

export const useDeleteLabel = (projectId: string) =>
  useLabelsMutation(projectId, (labelId: string) =>
    apiFetch(`/labels/${labelId}`, { method: 'DELETE' }),
  );
