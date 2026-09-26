'use client';

import { can, type Permission, type ProjectDetail } from '@forge/types';
import { createContext, useContext } from 'react';

const ProjectContext = createContext<ProjectDetail | null>(null);

export const ProjectProvider = ProjectContext.Provider;

export function useCurrentProject(): ProjectDetail {
  const project = useContext(ProjectContext);
  if (!project) throw new Error('useCurrentProject must be used inside a project page');
  return project;
}

/**
 * Whether the caller's role allows an action. Only hides controls the API would reject anyway;
 * the API enforces the same permission table on every request.
 */
export function useCan(permission: Permission): boolean {
  const project = useCurrentProject();
  const writable =
    !project.archivedAt || permission === 'project:read' || permission === 'project:archive';
  return writable && can(project.myRole, permission);
}
