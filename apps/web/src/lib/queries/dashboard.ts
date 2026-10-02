import { ProjectDashboard } from '@forge/types';
import { keepPreviousData, useQuery } from '@tanstack/react-query';

import { apiJson } from '@/lib/api';

export const dashboardKeys = {
  project: (projectId: string, weeks: number) => ['dashboard', projectId, weeks] as const,
};

/** FR-10. Refreshed every minute while open; the previous window stays shown while switching. */
export function useDashboard(projectId: string, weeks: number) {
  return useQuery({
    queryKey: dashboardKeys.project(projectId, weeks),
    queryFn: () =>
      apiJson(`/projects/${projectId}/dashboard?weeks=${String(weeks)}`, ProjectDashboard),
    placeholderData: keepPreviousData,
    refetchInterval: 60_000,
  });
}
