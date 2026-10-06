import { IssueStatus } from '@forge/types';

import { OPEN_STATUSES } from './open-issues';

describe('OPEN_STATUSES', () => {
  it('lists every status except the terminal ones, so a new status cannot be left out silently', () => {
    const terminal = ['DONE', 'CANCELLED'];
    expect([...OPEN_STATUSES].sort()).toEqual(
      IssueStatus.options.filter((s) => !terminal.includes(s)).sort(),
    );
  });
});
