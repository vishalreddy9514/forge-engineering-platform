import type { IssueDetail, IssueSummary } from '@forge/types';

const pm = {
  id: '00000000-0000-4000-8000-000000000001',
  displayName: 'Priya Shah',
  email: 'priya@forge.local',
  avatarUrl: null,
};
export const dev = {
  id: '00000000-0000-4000-8000-000000000002',
  displayName: 'Dev Patel',
  email: 'dev@forge.local',
  avatarUrl: null,
};

export function issueSummary(overrides: Partial<IssueSummary> = {}): IssueSummary {
  return {
    id: '10000000-0000-4000-8000-000000000001',
    key: 'PAY-1',
    number: 1,
    title: 'Card payments time out',
    type: 'BUG',
    status: 'TODO',
    priority: 'HIGH',
    assignee: null,
    labels: [],
    storyPoints: null,
    dueDate: null,
    commentCount: 0,
    version: 1,
    createdAt: '2026-09-20T10:00:00.000Z',
    updatedAt: '2026-09-20T10:00:00.000Z',
    ...overrides,
  };
}

export function issueDetail(overrides: Partial<IssueDetail> = {}): IssueDetail {
  return {
    ...issueSummary(),
    projectId: '20000000-0000-4000-8000-000000000001',
    projectKey: 'PAY',
    description: null,
    reporter: pm,
    resolvedAt: null,
    ...overrides,
  };
}
