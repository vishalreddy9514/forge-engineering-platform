import type { Burndown, Velocity } from '@forge/types';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { BurndownChart } from './burndown-chart';
import { niceTicks, shortDate } from './chart-frame';
import { VelocityChart } from './velocity-chart';

const burndown: Burndown = {
  sprintId: '0192f3a4-0000-7000-8000-000000000001',
  startDate: '2026-10-05',
  endDate: '2026-10-09',
  committed: 8,
  days: [
    { date: '2026-10-05', remaining: 8, ideal: 8, scopeChange: 0 },
    { date: '2026-10-06', remaining: 10, ideal: 6, scopeChange: 2 },
    { date: '2026-10-07', remaining: 5, ideal: 4, scopeChange: 0 },
    { date: '2026-10-08', remaining: null, ideal: 2, scopeChange: 0 },
    { date: '2026-10-09', remaining: null, ideal: 0, scopeChange: 0 },
  ],
};

describe('chart helpers', () => {
  it('produces round ticks that cover the maximum', () => {
    expect(niceTicks(8)).toEqual([0, 2, 4, 6, 8]);
    expect(niceTicks(13)).toEqual([0, 5, 10, 15]);
    expect(niceTicks(0)).toEqual([0, 1]);
  });

  it('formats dates in UTC', () => {
    expect(shortDate('2026-10-05')).toMatch(/5/);
  });
});

describe('BurndownChart', () => {
  it('summarises progress, has a legend, and a table of every day', async () => {
    render(<BurndownChart burndown={burndown} />);
    expect(
      screen.getByRole('img', { name: /5 of 8 committed points remaining/ }),
    ).toBeInTheDocument();
    const legend = screen.getByRole('list', { name: 'Legend' });
    expect(within(legend).getByText('Remaining')).toBeInTheDocument();
    expect(within(legend).getByText('Ideal')).toBeInTheDocument();

    await userEvent.click(screen.getByText('Show data table'));
    const rows = screen.getAllByRole('row');
    expect(rows).toHaveLength(6); // header + 5 days
    expect(within(rows[4] as HTMLElement).getAllByRole('cell')[1]).toHaveTextContent('—');
  });

  it('shows every value for a day from the keyboard', () => {
    render(<BurndownChart burndown={burndown} />);
    const chart = screen.getByRole('img');
    chart.focus();
    fireEvent.keyDown(chart, { key: 'ArrowRight' });
    fireEvent.keyDown(chart, { key: 'ArrowRight' });
    const tip = screen.getByRole('status');
    expect(tip).toHaveTextContent('10remaining');
    expect(tip).toHaveTextContent('6ideal');
    expect(tip).toHaveTextContent('Scope +2 pts');
  });

  it('describes a sprint that has not started', () => {
    render(
      <BurndownChart
        burndown={{ ...burndown, days: burndown.days.map((d) => ({ ...d, remaining: null })) }}
      />,
    );
    expect(
      screen.getByRole('img', { name: /8 points planned; the sprint has not started/ }),
    ).toBeInTheDocument();
  });
});

describe('VelocityChart', () => {
  const velocity: Velocity = {
    sprints: [
      {
        id: '0192f3a4-0000-7000-8000-000000000001',
        name: 'PAY Sprint 1',
        completedAt: '2026-09-20T00:00:00Z',
        committed: 21,
        completed: 18,
      },
      {
        id: '0192f3a4-0000-7000-8000-000000000002',
        name: 'PAY Sprint 2',
        completedAt: '2026-10-04T00:00:00Z',
        committed: 20,
        completed: 20,
      },
    ],
    average: 19,
  };

  it('labels each sprint, the average, and exposes values on focus', () => {
    render(<VelocityChart velocity={velocity} />);
    expect(screen.getByText(/19 points per sprint on average/)).toBeInTheDocument();
    const first = screen.getByRole('img', { name: 'PAY Sprint 1: 18 of 21 points completed' });
    fireEvent.focus(first);
    expect(screen.getByRole('status')).toHaveTextContent('18completed');
    expect(screen.getByRole('status')).toHaveTextContent('21committed');
  });

  it('explains the empty state', () => {
    render(<VelocityChart velocity={{ sprints: [], average: null }} />);
    expect(screen.getByText('Complete a sprint to see velocity.')).toBeInTheDocument();
  });
});
