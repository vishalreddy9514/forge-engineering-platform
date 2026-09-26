import { type ExecutionContext, ForbiddenException, NotFoundException } from '@nestjs/common';
import { type Reflector } from '@nestjs/core';

import type { AccessControlService } from './access-control.service';
import { ProjectAccessGuard, type ProjectScopedRequest } from './project-access.guard';
import type { ProjectPermissionRequirement } from './project-permission.metadata';

const PROJECT_ID = '01920000-0000-7000-8000-000000000001';
const ISSUE_ID = '01920000-0000-7000-8000-0000000000aa';

function setup(requirement: ProjectPermissionRequirement | undefined) {
  const reflector = { get: jest.fn().mockReturnValue(requirement) } as unknown as Reflector;
  const access = {
    resolveProjectId: jest.fn(),
    getRole: jest.fn(),
  };
  const guard = new ProjectAccessGuard(reflector, access as unknown as AccessControlService);

  const run = (req: Partial<ProjectScopedRequest>) =>
    guard.canActivate({
      getHandler: () => undefined,
      switchToHttp: () => ({ getRequest: () => req }),
    } as unknown as ExecutionContext);

  return { access, run };
}

const developer = { id: 'user-1', isAdmin: false };

describe('ProjectAccessGuard', () => {
  it('lets routes without a requirement through', async () => {
    const { run } = setup(undefined);
    await expect(run({})).resolves.toBe(true);
  });

  it('allows a member whose role has the permission, and records the access', async () => {
    const { access, run } = setup({ permission: 'issue:update', scope: 'issue', param: 'issueId' });
    access.resolveProjectId.mockResolvedValue(PROJECT_ID);
    access.getRole.mockResolvedValue('DEVELOPER');
    const req = {
      params: { issueId: ISSUE_ID },
      user: developer,
    } as unknown as ProjectScopedRequest;

    await expect(run(req)).resolves.toBe(true);
    expect(access.resolveProjectId).toHaveBeenCalledWith('issue', ISSUE_ID);
    expect(req.projectAccess).toEqual({ projectId: PROJECT_ID, role: 'DEVELOPER' });
  });

  it('returns 403 for a member whose role lacks the permission', async () => {
    const { access, run } = setup({ permission: 'issue:delete', scope: 'issue', param: 'issueId' });
    access.resolveProjectId.mockResolvedValue(PROJECT_ID);
    access.getRole.mockResolvedValue('DEVELOPER');

    await expect(run({ params: { issueId: ISSUE_ID }, user: developer })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('returns 404, not 403, to non-members so project IDs cannot be probed', async () => {
    const { access, run } = setup({
      permission: 'project:read',
      scope: 'project',
      param: 'projectId',
    });
    access.resolveProjectId.mockResolvedValue(PROJECT_ID);
    access.getRole.mockResolvedValue(null);

    await expect(
      run({
        params: { projectId: PROJECT_ID },
        user: developer,
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('returns 404 when the resource does not exist', async () => {
    const { access, run } = setup({ permission: 'issue:update', scope: 'issue', param: 'issueId' });
    access.resolveProjectId.mockResolvedValue(null);

    await expect(run({ params: { issueId: ISSUE_ID }, user: developer })).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(access.getRole).not.toHaveBeenCalled();
  });

  it('gives platform admins every permission without a membership lookup', async () => {
    const { access, run } = setup({
      permission: 'member:manage',
      scope: 'project',
      param: 'projectId',
    });
    access.resolveProjectId.mockResolvedValue(PROJECT_ID);
    const req = {
      params: { projectId: PROJECT_ID },
      user: { id: 'admin', isAdmin: true },
    } as unknown as ProjectScopedRequest;

    await expect(run(req)).resolves.toBe(true);
    expect(access.getRole).not.toHaveBeenCalled();
    expect(req.projectAccess.role).toBe('ADMIN');
  });
});
