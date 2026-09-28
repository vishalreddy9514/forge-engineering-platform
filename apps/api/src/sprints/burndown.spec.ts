import { computeBurndown, type BurndownInput, type FieldChange, type Membership } from './burndown';

const at = (iso: string) => new Date(iso);
const member = (issueId: string, added: string, extra: Partial<Membership> = {}): Membership => ({
  issueId,
  addedAt: at(added),
  removedAt: null,
  outcome: null,
  ...extra,
});
const status = (issueId: string, from: string, to: string, when: string): FieldChange => ({
  issueId,
  field: 'status',
  oldValue: from,
  newValue: to,
  at: at(when),
});

/** A five-day sprint, Mon 5 Oct to Fri 9 Oct 2026, started Monday 09:00. */
function sprint(overrides: Partial<BurndownInput> = {}): BurndownInput {
  return {
    sprintId: '0192f3a4-0000-7000-8000-000000000001',
    startDate: '2026-10-05',
    endDate: '2026-10-09',
    startedAt: at('2026-10-05T09:00:00Z'),
    completedAt: null,
    now: at('2026-10-10T12:00:00Z'),
    memberships: [member('a', '2026-10-05T09:00:00Z'), member('b', '2026-10-05T09:00:00Z')],
    issues: new Map([
      ['a', { status: 'DONE', storyPoints: 5 }],
      ['b', { status: 'IN_PROGRESS', storyPoints: 3 }],
    ]),
    changes: [status('a', 'IN_PROGRESS', 'DONE', '2026-10-07T15:00:00Z')],
    ...overrides,
  };
}

const remaining = (input: BurndownInput) => computeBurndown(input).days.map((d) => d.remaining);

describe('computeBurndown', () => {
  it('burns points on the day an issue is done, using the status at the time', () => {
    const result = computeBurndown(sprint());
    expect(result.committed).toBe(8);
    expect(result.days.map((d) => d.date)).toEqual([
      '2026-10-05',
      '2026-10-06',
      '2026-10-07',
      '2026-10-08',
      '2026-10-09',
    ]);
    expect(result.days.map((d) => d.remaining)).toEqual([8, 8, 3, 3, 3]);
    expect(result.days.map((d) => d.ideal)).toEqual([8, 6, 4, 2, 0]);
  });

  it('treats reopened issues as remaining again, and cancelled ones as gone', () => {
    const input = sprint({
      changes: [
        status('a', 'IN_PROGRESS', 'DONE', '2026-10-06T10:00:00Z'),
        status('a', 'DONE', 'IN_PROGRESS', '2026-10-07T10:00:00Z'),
        status('a', 'IN_PROGRESS', 'DONE', '2026-10-08T10:00:00Z'),
        status('b', 'IN_PROGRESS', 'CANCELLED', '2026-10-09T10:00:00Z'),
      ],
      issues: new Map([
        ['a', { status: 'DONE', storyPoints: 5 }],
        ['b', { status: 'CANCELLED', storyPoints: 3 }],
      ]),
    });
    expect(remaining(input)).toEqual([8, 3, 8, 3, 0]);
  });

  it('uses the story points in effect each day and reports scope changes', () => {
    const input = sprint({
      memberships: [
        member('a', '2026-10-05T09:00:00Z'),
        member('b', '2026-10-05T09:00:00Z', {
          removedAt: at('2026-10-08T11:00:00Z'),
          outcome: 'REMOVED',
        }),
        member('c', '2026-10-06T14:00:00Z'), // added mid-sprint
      ],
      issues: new Map([
        ['a', { status: 'IN_PROGRESS', storyPoints: 8 }],
        ['b', { status: 'TODO', storyPoints: 3 }],
        ['c', { status: 'TODO', storyPoints: 2 }],
      ]),
      changes: [
        {
          issueId: 'a',
          field: 'storyPoints',
          oldValue: 5,
          newValue: 8,
          at: at('2026-10-07T09:00:00Z'),
        },
      ],
    });
    const result = computeBurndown(input);
    expect(result.committed).toBe(8); // a=5 + b=3 at the start
    expect(result.days.map((d) => d.remaining)).toEqual([8, 10, 13, 10, 10]);
    expect(result.days.map((d) => d.scopeChange)).toEqual([0, 2, 0, -3, 0]);
  });

  it('leaves future days empty for a running sprint', () => {
    expect(remaining(sprint({ now: at('2026-10-06T12:00:00Z') }))).toEqual([
      8,
      8,
      null,
      null,
      null,
    ]);
  });

  it('counts issues still in a completed sprint until completion, then stops', () => {
    const completedAt = at('2026-10-08T17:00:00Z');
    const input = sprint({
      completedAt,
      memberships: [
        member('a', '2026-10-05T09:00:00Z', { removedAt: completedAt, outcome: 'COMPLETED' }),
        member('b', '2026-10-05T09:00:00Z', { removedAt: completedAt, outcome: 'CARRIED_OVER' }),
      ],
    });
    expect(remaining(input)).toEqual([8, 8, 3, 3, null]);
  });

  it('infers the value before the first recorded change from that change', () => {
    // b's points were never changed, a's status history starts after the sprint start.
    const input = sprint({
      issues: new Map([
        ['a', { status: 'DONE', storyPoints: 5 }],
        ['b', { status: 'DONE', storyPoints: null }],
      ]),
      changes: [status('a', 'TODO', 'DONE', '2026-10-09T10:00:00Z')],
    });
    expect(remaining(input)).toEqual([5, 5, 5, 5, 0]);
  });

  it('shows a planned sprint as its current scope with nothing burned yet', () => {
    const input = sprint({ startedAt: null });
    const result = computeBurndown(input);
    expect(result.committed).toBe(8);
    expect(result.days.every((d) => d.remaining === null)).toBe(true);
  });
});
