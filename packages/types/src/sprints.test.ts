import { ListIssuesQuery } from './issues';
import {
  CompleteSprintRequest,
  CreateSprintRequest,
  MAX_SPRINT_DAYS,
  SprintIssuesRequest,
  UpdateSprintRequest,
} from './sprints';

const errorPaths = (result: { success: boolean; error?: { issues: { path: PropertyKey[] }[] } }) =>
  result.error?.issues.map((i) => i.path.join('.')) ?? [];

describe('sprint requests', () => {
  const valid = { name: '  Sprint 4 ', startDate: '2026-10-01', endDate: '2026-10-14' };

  it('accepts a two-week sprint and trims the name', () => {
    expect(CreateSprintRequest.parse(valid)).toEqual({ ...valid, name: 'Sprint 4' });
    expect(CreateSprintRequest.parse({ ...valid, endDate: valid.startDate }).endDate).toBe(
      '2026-10-01',
    );
  });

  it('rejects dates out of order, overly long sprints and bad dates', () => {
    expect(errorPaths(CreateSprintRequest.safeParse({ ...valid, endDate: '2026-09-30' }))).toEqual([
      'endDate',
    ]);
    const tooLong = new Date(Date.parse(valid.startDate) + MAX_SPRINT_DAYS * 86_400_000)
      .toISOString()
      .slice(0, 10);
    expect(errorPaths(CreateSprintRequest.safeParse({ ...valid, endDate: tooLong }))).toEqual([
      'endDate',
    ]);
    expect(CreateSprintRequest.safeParse({ ...valid, startDate: '2026-02-30' }).success).toBe(
      false,
    );
    expect(CreateSprintRequest.safeParse({ ...valid, name: '  ' }).success).toBe(false);
  });

  it('requires at least one field to update and checks dates given together', () => {
    expect(UpdateSprintRequest.safeParse({}).success).toBe(false);
    expect(UpdateSprintRequest.parse({ goal: null })).toEqual({ goal: null });
    expect(
      UpdateSprintRequest.safeParse({ startDate: '2026-10-10', endDate: '2026-10-01' }).success,
    ).toBe(false);
  });

  it('sends open issues to the backlog unless a sprint is chosen', () => {
    expect(CompleteSprintRequest.parse({})).toEqual({ moveOpenIssuesTo: 'backlog' });
    expect(CompleteSprintRequest.safeParse({ moveOpenIssuesTo: 'next' }).success).toBe(false);
  });

  it('limits and de-duplicates issue batches', () => {
    const id = '0192f3a4-0000-7000-8000-000000000001';
    expect(SprintIssuesRequest.safeParse({ issueIds: [] }).success).toBe(false);
    expect(SprintIssuesRequest.safeParse({ issueIds: [id, id] }).success).toBe(false);
  });

  it('filters issues by sprint, active sprint or backlog', () => {
    expect(ListIssuesQuery.parse({ sprint: 'active' }).sprint).toBe('active');
    expect(ListIssuesQuery.parse({ sprint: 'none' }).sprint).toBe('none');
    expect(ListIssuesQuery.safeParse({ sprint: 'current' }).success).toBe(false);
  });
});
