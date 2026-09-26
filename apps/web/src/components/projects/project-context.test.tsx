import type { Permission, ProjectDetail } from '@forge/types';
import { render, screen } from '@testing-library/react';

import { ProjectProvider, useCan } from './project-context';

function Probe({ permission }: { permission: Permission }) {
  return <span>{useCan(permission) ? 'yes' : 'no'}</span>;
}

const project = (overrides: Partial<ProjectDetail>): ProjectDetail =>
  ({ myRole: 'DEVELOPER', archivedAt: null, ...overrides }) as ProjectDetail;

function check(p: ProjectDetail, permission: Permission) {
  const { unmount } = render(
    <ProjectProvider value={p}>
      <Probe permission={permission} />
    </ProjectProvider>,
  );
  const answer = screen.getByText(/yes|no/).textContent;
  unmount();
  return answer;
}

describe('useCan', () => {
  it('follows the shared permission matrix', () => {
    expect(check(project({ myRole: 'DEVELOPER' }), 'issue:create')).toBe('yes');
    expect(check(project({ myRole: 'DEVELOPER' }), 'member:manage')).toBe('no');
    expect(check(project({ myRole: 'VIEWER' }), 'issue:create')).toBe('no');
    expect(check(project({ myRole: 'ADMIN' }), 'member:manage')).toBe('yes');
  });

  it('hides writes in archived projects but keeps reading and restoring', () => {
    const archived = project({ myRole: 'PROJECT_MANAGER', archivedAt: '2026-09-26T00:00:00Z' });
    expect(check(archived, 'issue:create')).toBe('no');
    expect(check(archived, 'project:read')).toBe('yes');
    expect(check(archived, 'project:archive')).toBe('yes');
  });
});
