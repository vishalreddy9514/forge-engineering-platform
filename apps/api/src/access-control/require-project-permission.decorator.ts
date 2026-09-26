import { applyDecorators, SetMetadata, UseGuards } from '@nestjs/common';
import { ApiForbiddenResponse, ApiNotFoundResponse } from '@nestjs/swagger';

import type { ProjectScope } from './access-control.service';
import type { Permission } from './permissions';
import { ProjectAccessGuard } from './project-access.guard';
import {
  PROJECT_PERMISSION_KEY,
  type ProjectPermissionRequirement,
} from './project-permission.metadata';

/**
 * Requires `permission` in the project that owns the route's resource, e.g.
 * `@RequireProjectPermission('issue:update', 'issue', 'issueId')`.
 * Non-members get 404 (the project's existence is not revealed); members without the
 * permission get 403.
 */
export function RequireProjectPermission(
  permission: Permission,
  scope: ProjectScope = 'project',
  param = scope === 'project' ? 'projectId' : `${scope}Id`,
) {
  return applyDecorators(
    SetMetadata(PROJECT_PERMISSION_KEY, {
      permission,
      scope,
      param,
    } satisfies ProjectPermissionRequirement),
    UseGuards(ProjectAccessGuard),
    ApiNotFoundResponse({ description: 'Resource not found, or not visible to the caller' }),
    ApiForbiddenResponse({ description: `Requires the "${permission}" permission` }),
  );
}
