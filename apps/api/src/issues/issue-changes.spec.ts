import { diffIssue, type IssueSnapshot } from './issue-changes';

const NOW = new Date('2026-09-26T12:00:00.000Z');
const bug = { id: 'l-bug', name: 'bug' };
const api = { id: 'l-api', name: 'api' };

const before: IssueSnapshot = {
  title: 'Refunds fail',
  description: 'Steps…',
  type: 'BUG',
  status: 'IN_PROGRESS',
  priority: 'HIGH',
  assigneeId: 'u-sam',
  storyPoints: 3,
  dueDate: new Date('2026-10-01T00:00:00.000Z'),
  labels: [bug],
};

const lookup = (overrides: Partial<Parameters<typeof diffIssue>[2]> = {}) => ({
  assignees: { before: { id: 'u-sam', name: 'Sam' }, after: null },
  labelNames: new Map([
    ['l-bug', 'bug'],
    ['l-api', 'api'],
  ]),
  now: NOW,
  ...overrides,
});

describe('diffIssue', () => {
  it('ignores fields sent with their current value', () => {
    const changes = diffIssue(
      before,
      {
        title: 'Refunds fail',
        priority: 'HIGH',
        status: 'IN_PROGRESS',
        assigneeId: 'u-sam',
        dueDate: '2026-10-01',
        labelIds: ['l-bug'],
        storyPoints: 3,
      },
      lookup(),
    );
    expect(changes).toEqual({ data: {}, events: [], labels: { add: [], remove: [] } });
  });

  it('records one event per changed field, with old and new values', () => {
    const changes = diffIssue(
      before,
      { title: 'Refunds fail for partial captures', priority: 'CRITICAL' },
      lookup(),
    );
    expect(changes.data).toEqual({
      title: 'Refunds fail for partial captures',
      priority: 'CRITICAL',
    });
    expect(changes.events).toEqual([
      {
        type: 'FIELD_CHANGED',
        field: 'title',
        oldValue: 'Refunds fail',
        newValue: 'Refunds fail for partial captures',
      },
      { type: 'FIELD_CHANGED', field: 'priority', oldValue: 'HIGH', newValue: 'CRITICAL' },
    ]);
  });

  it('sets resolvedAt when an issue is finished and clears it when reopened', () => {
    expect(diffIssue(before, { status: 'DONE' }, lookup()).data).toEqual({
      status: 'DONE',
      resolvedAt: NOW,
    });
    expect(diffIssue({ ...before, status: 'DONE' }, { status: 'TODO' }, lookup()).data).toEqual({
      status: 'TODO',
      resolvedAt: null,
    });
    // Moving between two terminal states keeps the original resolution time.
    expect(
      diffIssue({ ...before, status: 'DONE' }, { status: 'CANCELLED' }, lookup()).data,
    ).toEqual({
      status: 'CANCELLED',
    });
  });

  it('stores assignee changes as name snapshots', () => {
    const changes = diffIssue(
      before,
      { assigneeId: 'u-mei' },
      lookup({
        assignees: { before: { id: 'u-sam', name: 'Sam' }, after: { id: 'u-mei', name: 'Mei' } },
      }),
    );
    expect(changes.data).toEqual({ assigneeId: 'u-mei' });
    expect(changes.events[0]).toEqual({
      type: 'FIELD_CHANGED',
      field: 'assignee',
      oldValue: { id: 'u-sam', name: 'Sam' },
      newValue: { id: 'u-mei', name: 'Mei' },
    });
  });

  it('treats labels as a set: adds and removals become separate events', () => {
    const changes = diffIssue(before, { labelIds: ['l-api'] }, lookup());
    expect(changes.labels).toEqual({ add: ['l-api'], remove: ['l-bug'] });
    expect(changes.events).toEqual([
      { type: 'LABEL_ADDED', field: 'labels', oldValue: null, newValue: api },
      { type: 'LABEL_REMOVED', field: 'labels', oldValue: bug, newValue: null },
    ]);
  });

  it('handles clearing optional fields', () => {
    const changes = diffIssue(
      before,
      { dueDate: null, storyPoints: null, description: null },
      lookup(),
    );
    expect(changes.data).toEqual({ dueDate: null, storyPoints: null, description: null });
    expect(changes.events.map((e) => e.field)).toEqual(['description', 'storyPoints', 'dueDate']);
  });
});
