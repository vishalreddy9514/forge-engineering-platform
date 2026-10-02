import type { ProjectDashboard as Dashboard } from '@forge/types';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { BarList } from './bar-list';
import { compact, duration, usd } from './format';
import { aiByFeature, aiTokensByWeek, ProjectDashboard } from './project-dashboard';
import { WeeklyColumns } from './weekly-columns';

let result: { data?: Dashboard; isPending: boolean; isError: boolean; isFetching: boolean };
const requested: number[] = [];
jest.mock('@/lib/queries/dashboard', () => ({
  useDashboard: (_projectId: string, weeks: number) => {
    requested.push(weeks);
    return result;
  },
}));

const weeks = ['2026-09-14', '2026-09-21', '2026-09-28'];
const dashboard: Dashboard = {
  generatedAt: '2026-10-01T12:00:00.000Z',
  since: weeks[0] ?? '',
  issues: {
    open: 5,
    byStatus: { BACKLOG: 1, TODO: 2, IN_PROGRESS: 1, IN_REVIEW: 1, DONE: 4, CANCELLED: 0 },
    byPriority: { CRITICAL: 1, HIGH: 2, MEDIUM: 1, LOW: 1 },
  },
  activeSprint: {
    id: '01900000-0000-7000-8000-000000000001',
    name: 'PAY Sprint 2',
    goal: 'Money correctness',
    startDate: '2026-09-25',
    endDate: '2026-10-08',
    totalPoints: 21,
    donePoints: 8,
    totalIssues: 6,
    doneIssues: 2,
    burndown: {
      sprintId: '01900000-0000-7000-8000-000000000001',
      startDate: '2026-09-25',
      endDate: '2026-09-26',
      committed: 21,
      days: [
        { date: '2026-09-25', remaining: 21, ideal: 21, scopeChange: 0 },
        { date: '2026-09-26', remaining: 13, ideal: 0, scopeChange: 0 },
      ],
    },
  },
  workload: [
    {
      assignee: {
        id: '01900000-0000-7000-8000-000000000002',
        displayName: 'Sam Okafor',
        email: 'sam@forge.local',
        avatarUrl: null,
      },
      openIssues: 3,
      openPoints: 11,
    },
    { assignee: null, openIssues: 1, openPoints: 1 },
  ],
  pullRequests: {
    repositories: 1,
    weeks: [
      { weekStart: '2026-09-14', opened: 0, merged: 0 },
      { weekStart: '2026-09-21', opened: 3, merged: 1 },
      { weekStart: '2026-09-28', opened: 1, merged: 2 },
    ],
  },
  resolution: { resolved: 4, medianHours: 25, p90Hours: 79 },
  aiUsage: {
    weeks: [
      { weekStart: '2026-09-21', feature: 'PR_REVIEW', requests: 1, tokens: 10_000, costUsd: 0.02 },
      { weekStart: '2026-09-28', feature: 'CHAT', requests: 2, tokens: 1_500, costUsd: 0.003 },
      { weekStart: '2026-09-28', feature: 'PR_REVIEW', requests: 1, tokens: 9_000, costUsd: 0.018 },
    ],
    totals: { requests: 4, tokens: 20_500, costUsd: 0.041 },
  },
};

describe('formatting', () => {
  it('shows hours for short waits and days past two of them', () => {
    expect(duration(5.5)).toBe('5.5 h');
    expect(duration(47.9)).toBe('47.9 h');
    expect(duration(79)).toBe('3.3 d');
    expect(duration(null)).toBe('–');
  });

  it('keeps small costs non-zero', () => {
    expect(usd(0)).toBe('$0');
    expect(usd(0.0025)).toBe('$0.0025');
    expect(usd(1.237)).toBe('$1.24');
    expect(usd(12.4)).toBe('$12');
    expect(compact(12_400)).toBe('12.4K');
  });
});

describe('AI usage helpers', () => {
  it('totals the sparse rows per week, aligned to every week', () => {
    expect(aiTokensByWeek(dashboard, weeks)).toEqual([0, 10_000, 10_500]);
  });

  it('totals the period per feature, most expensive first', () => {
    expect(aiByFeature(dashboard)).toEqual([
      { feature: 'PR_REVIEW', requests: 2, tokens: 19_000, costUsd: 0.038 },
      { feature: 'CHAT', requests: 2, tokens: 1_500, costUsd: 0.003 },
    ]);
  });
});

describe('BarList', () => {
  it('labels every row with its value and says so when there is nothing', () => {
    const { rerender } = render(
      <BarList
        title="Workload"
        rows={[{ key: 'a', label: 'Sam', value: 11, detail: '3 issues' }]}
        format={(v) => `${String(v)} pts`}
        empty="No open issues."
      />,
    );
    const list = screen.getByRole('region', { name: 'Workload' });
    expect(within(list).getByText('Sam')).toBeInTheDocument();
    expect(within(list).getByText('11 pts')).toBeInTheDocument();
    expect(within(list).getByText('3 issues')).toBeInTheDocument();
    rerender(<BarList title="Workload" rows={[]} empty="No open issues." />);
    expect(screen.getByText('No open issues.')).toBeInTheDocument();
  });
});

describe('WeeklyColumns', () => {
  const series = [
    { label: 'Opened', slot: 'chart-2' as const, values: [0, 3, 1] },
    { label: 'Merged', slot: 'chart-1' as const, values: [0, 1, 2] },
  ];

  it('describes each week for assistive tech, has a legend and a data table', async () => {
    render(<WeeklyColumns title="Pull requests" weeks={weeks} series={series} empty="None." />);
    expect(screen.getByRole('list', { name: 'Legend' })).toHaveTextContent('OpenedMerged');
    const week = screen.getByRole('img', { name: /: 3 opened, 1 merged$/ });
    fireEvent.pointerEnter(week);
    expect(screen.getByRole('status')).toHaveTextContent(/3\s*opened/);
    await userEvent.click(screen.getByText('Show data table'));
    expect(screen.getAllByRole('row')).toHaveLength(4);
  });

  it('shows the empty message instead of an all-zero chart', () => {
    render(
      <WeeklyColumns
        title="Tokens"
        weeks={weeks}
        series={[{ label: 'Tokens', slot: 'chart-1', values: [0, 0, 0] }]}
        empty="No AI requests in this period."
      />,
    );
    expect(screen.getByText('No AI requests in this period.')).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Legend' })).not.toBeInTheDocument();
  });
});

describe('ProjectDashboard', () => {
  beforeEach(() => {
    requested.length = 0;
    result = { data: dashboard, isPending: false, isError: false, isFetching: false };
  });

  const renderIt = () => render(<ProjectDashboard projectId="p1" projectKey="PAY" />);

  it('leads with the headline numbers', () => {
    renderIt();
    const tile = (label: string) => {
      const dt = screen.getByText(label, { selector: 'dt' });
      return dt.parentElement as HTMLElement;
    };
    expect(tile('Open issues')).toHaveTextContent('51 critical · 2 high');
    expect(tile('PAY Sprint 2')).toHaveTextContent('8 / 21 pts');
    expect(screen.getByRole('meter', { name: 'Sprint points done' })).toHaveAttribute(
      'aria-valuetext',
      '8 of 21 points done',
    );
    expect(tile('Median resolution')).toHaveTextContent('25 hp90 3.3 d · 4 done');
    expect(tile('PRs merged')).toHaveTextContent('34 opened'); // 3 merged, 4 opened in the period
    expect(tile('AI cost')).toHaveTextContent('$0.04');
  });

  it('shows workload, the burndown and AI usage by feature', () => {
    renderIt();
    const workload = screen.getByRole('region', { name: 'Workload: open points per person' });
    expect(
      within(workload)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['Sam Okafor3 issues11 pts', 'Unassigned1 issue1 pts']);
    expect(screen.getByText('Goal: Money correctness')).toBeInTheDocument();
    const table = screen.getByRole('table', { name: 'AI usage by feature' });
    expect(within(table).getAllByRole('row')[1]).toHaveTextContent('Code review219K$0.04');
  });

  it('points to the Code tab when no repository is linked, and to Sprints with no sprint', () => {
    result = {
      ...result,
      data: {
        ...dashboard,
        activeSprint: null,
        pullRequests: { ...dashboard.pullRequests, repositories: 0 },
      },
    };
    renderIt();
    expect(screen.getByRole('link', { name: 'Link one on the Code tab' })).toHaveAttribute(
      'href',
      '/projects/PAY/code',
    );
    expect(screen.getByRole('link', { name: 'Plan one' })).toHaveAttribute(
      'href',
      '/projects/PAY/sprints',
    );
    expect(screen.getByText('No repository linked')).toBeInTheDocument();
  });

  it('changes the period', async () => {
    renderIt();
    await userEvent.selectOptions(screen.getByLabelText('Period'), '12');
    expect(requested.at(-1)).toBe(12);
  });

  it('says so when the dashboard cannot load', () => {
    result = { isPending: false, isError: true, isFetching: false };
    renderIt();
    expect(screen.getByRole('alert')).toHaveTextContent('could not be loaded');
  });
});
