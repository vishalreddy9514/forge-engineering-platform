import { AI_FEATURE_LABELS, AiFeature, DashboardQuery, ProjectDashboard } from './dashboard';

describe('dashboard contracts', () => {
  it('defaults to eight weeks and caps the window at half a year', () => {
    expect(DashboardQuery.parse({})).toEqual({ weeks: 8 });
    expect(DashboardQuery.parse({ weeks: '12' })).toEqual({ weeks: 12 });
    expect(DashboardQuery.safeParse({ weeks: '27' }).success).toBe(false);
    expect(DashboardQuery.safeParse({ weeks: '0' }).success).toBe(false);
  });

  it('labels every AI feature', () => {
    expect(Object.keys(AI_FEATURE_LABELS).sort()).toEqual([...AiFeature.options].sort());
  });

  const empty = {
    generatedAt: '2026-10-01T12:00:00.000Z',
    since: '2026-08-10',
    issues: {
      open: 0,
      byStatus: { BACKLOG: 0, TODO: 0, IN_PROGRESS: 0, IN_REVIEW: 0, DONE: 0, CANCELLED: 0 },
      byPriority: { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 },
    },
    activeSprint: null,
    workload: [],
    pullRequests: { repositories: 0, weeks: [] },
    resolution: { resolved: 0, medianHours: null, p90Hours: null },
    aiUsage: { weeks: [], totals: { requests: 0, tokens: 0, costUsd: 0 } },
  };

  it('accepts an empty project', () => {
    expect(ProjectDashboard.parse(empty)).toEqual(empty);
  });

  it('requires every status and priority, so charts never miss a bar', () => {
    const { DONE: _done, ...partial } = empty.issues.byStatus;
    expect(
      ProjectDashboard.safeParse({ ...empty, issues: { ...empty.issues, byStatus: partial } })
        .success,
    ).toBe(false);
  });
});
