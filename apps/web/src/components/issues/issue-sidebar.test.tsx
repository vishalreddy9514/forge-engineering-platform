import type { Label, ProjectMember } from '@forge/types';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { dev, issueDetail } from '../../../test-stubs/issue-fixtures';

import { IssueSidebar, statusOptions } from './issue-sidebar';

const members: ProjectMember[] = [
  { user: dev, role: 'DEVELOPER', addedAt: '2026-09-01T00:00:00Z' },
];
const [backend, urgent]: [Label, Label] = [
  {
    id: '30000000-0000-4000-8000-000000000001',
    name: 'backend',
    color: '#2563eb',
    description: null,
    issueCount: 1,
  },
  {
    id: '30000000-0000-4000-8000-000000000002',
    name: 'urgent',
    color: '#dc2626',
    description: null,
    issueCount: 0,
  },
];
const labels = [backend, urgent];

function renderSidebar(overrides: Parameters<typeof issueDetail>[0] = {}, canEdit = true) {
  const onChange = jest.fn();
  render(
    <IssueSidebar
      issue={issueDetail(overrides)}
      members={members}
      labels={labels}
      canEdit={canEdit}
      onChange={onChange}
    />,
  );
  return onChange;
}

describe('statusOptions', () => {
  it('lists the current status first, then the allowed transitions', () => {
    expect(statusOptions('BACKLOG')).toEqual(['BACKLOG', 'TODO', 'IN_PROGRESS', 'CANCELLED']);
    expect(statusOptions('DONE')).toEqual(['DONE', 'TODO', 'IN_PROGRESS']);
  });
});

describe('IssueSidebar', () => {
  it('offers only allowed status changes', () => {
    renderSidebar({ status: 'DONE' });
    const options = within(screen.getByLabelText('Status'))
      .getAllByRole('option')
      .map((o) => o.textContent);
    expect(options).toEqual(['Done', 'To do', 'In progress']);
  });

  it('saves a field as soon as it changes', async () => {
    const onChange = renderSidebar();
    await userEvent.selectOptions(screen.getByLabelText('Priority'), 'CRITICAL');
    expect(onChange).toHaveBeenLastCalledWith({ priority: 'CRITICAL' });
    await userEvent.selectOptions(screen.getByLabelText('Assignee'), dev.id);
    expect(onChange).toHaveBeenLastCalledWith({ assigneeId: dev.id });
  });

  it('sends the complete label set when a label is toggled', async () => {
    const onChange = renderSidebar({
      labels: [{ id: backend.id, name: 'backend', color: '#2563eb' }],
    });
    await userEvent.click(screen.getByRole('checkbox', { name: 'urgent' }));
    expect(onChange).toHaveBeenCalledWith({ labelIds: [backend.id, urgent.id] });
  });

  it('saves story points on blur and ignores invalid values', async () => {
    const onChange = renderSidebar();
    const points = screen.getByLabelText('Story points');
    await userEvent.type(points, '5');
    await userEvent.tab();
    expect(onChange).toHaveBeenCalledWith({ storyPoints: 5 });

    onChange.mockClear();
    await userEvent.clear(points);
    await userEvent.type(points, '101');
    await userEvent.tab();
    expect(onChange).not.toHaveBeenCalled();
    expect(points).toHaveValue(null);
  });

  it('is read-only for people who cannot edit issues', () => {
    renderSidebar({}, false);
    expect(screen.getByLabelText('Status')).toBeDisabled();
    expect(screen.getByLabelText('Due date')).toBeDisabled();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });
});
