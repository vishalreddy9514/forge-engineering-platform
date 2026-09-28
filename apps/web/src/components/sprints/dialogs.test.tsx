import type { Sprint } from '@forge/types';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { CompleteSprintDialog } from './complete-sprint-dialog';
import { CreateSprintDialog, suggestSprint } from './create-sprint-dialog';

const createSprint = jest.fn();
const completeSprint = jest.fn();
jest.mock('@/lib/queries/sprints', () => ({
  useCreateSprint: () => ({ mutateAsync: createSprint }),
  useCompleteSprint: () => ({ mutateAsync: completeSprint, isPending: false }),
}));

const sprint = (overrides: Partial<Sprint> = {}): Sprint => ({
  id: '0192f3a4-0000-7000-8000-000000000001',
  projectId: '0192f3a4-0000-7000-8000-0000000000aa',
  name: 'PAY Sprint 2',
  goal: null,
  status: 'ACTIVE',
  startDate: '2026-10-05',
  endDate: '2026-10-18',
  startedAt: '2026-10-05T09:00:00Z',
  completedAt: null,
  issueCount: 5,
  points: { total: 21, done: 13 },
  ...overrides,
});

describe('suggestSprint', () => {
  it('proposes the next two weeks after the latest sprint, with a free name', () => {
    expect(
      suggestSprint('PAY', [{ name: 'PAY Sprint 1', endDate: '2026-10-18' }], '2026-10-06'),
    ).toEqual({ name: 'PAY Sprint 2', goal: '', startDate: '2026-10-19', endDate: '2026-11-01' });
    // Old sprints in the past do not push the start date; taken names are skipped.
    expect(
      suggestSprint(
        'PAY',
        [
          { name: 'PAY Sprint 2', endDate: '2026-01-01' },
          { name: 'Hotfix', endDate: '2026-02-01' },
        ],
        '2026-10-06',
      ),
    ).toMatchObject({ name: 'PAY Sprint 3', startDate: '2026-10-06' });
  });
});

describe('CreateSprintDialog', () => {
  beforeEach(() => {
    createSprint.mockReset().mockResolvedValue({});
  });

  it('submits the suggested sprint and validates dates', async () => {
    render(
      <CreateSprintDialog
        projectId="p"
        defaults={{
          name: 'PAY Sprint 3',
          goal: '',
          startDate: '2026-10-19',
          endDate: '2026-11-01',
        }}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'New sprint' }));
    const end = screen.getByLabelText('End');
    await userEvent.clear(end);
    await userEvent.type(end, '2026-10-01');
    await userEvent.click(screen.getByRole('button', { name: 'Create sprint' }));
    expect(
      await screen.findByText('The end date must be on or after the start'),
    ).toBeInTheDocument();
    expect(createSprint).not.toHaveBeenCalled();

    await userEvent.clear(end);
    await userEvent.type(end, '2026-11-01');
    await userEvent.type(screen.getByLabelText('Goal (optional)'), 'Ship refunds');
    await userEvent.click(screen.getByRole('button', { name: 'Create sprint' }));
    expect(createSprint).toHaveBeenCalledWith({
      name: 'PAY Sprint 3',
      goal: 'Ship refunds',
      startDate: '2026-10-19',
      endDate: '2026-11-01',
    });
  });
});

describe('CompleteSprintDialog', () => {
  beforeEach(() => {
    completeSprint.mockReset().mockResolvedValue({
      sprint: sprint({ status: 'COMPLETED' }),
      completed: 3,
      movedToBacklog: 0,
      movedToSprint: 2,
    });
  });

  it('moves unfinished issues to the chosen planned sprint and reports the result', async () => {
    const next = sprint({
      id: '0192f3a4-0000-7000-8000-000000000002',
      name: 'PAY Sprint 3',
      status: 'PLANNED',
    });
    const onCompleted = jest.fn();
    render(
      <CompleteSprintDialog
        sprint={sprint()}
        openIssues={2}
        plannedSprints={[next]}
        onCompleted={onCompleted}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Complete sprint' }));
    expect(screen.getByText('2 issues are not done yet.')).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText('Move unfinished issues to'), next.id);
    await userEvent.click(
      screen.getAllByRole('button', { name: 'Complete sprint' }).at(-1) as HTMLElement,
    );

    expect(completeSprint).toHaveBeenCalledWith({
      sprintId: sprint().id,
      moveOpenIssuesTo: next.id,
    });
    await waitFor(() => {
      expect(onCompleted).toHaveBeenCalledWith(
        'PAY Sprint 2 completed: 3 done, 2 moved to the next sprint.',
      );
    });
  });

  it('skips the destination question when everything is resolved', async () => {
    render(
      <CompleteSprintDialog
        sprint={sprint()}
        openIssues={0}
        plannedSprints={[]}
        onCompleted={jest.fn()}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Complete sprint' }));
    expect(screen.getByText('Every issue in this sprint is resolved.')).toBeInTheDocument();
    expect(screen.queryByLabelText('Move unfinished issues to')).not.toBeInTheDocument();
  });
});
