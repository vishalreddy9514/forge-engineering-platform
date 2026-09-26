import type { ProjectScope } from './access-control.service';
import type { Permission } from './permissions';

export interface ProjectPermissionRequirement {
  permission: Permission;
  scope: ProjectScope;
  /** Route parameter holding the ID of the scoped resource. */
  param: string;
}

export const PROJECT_PERMISSION_KEY = 'projectPermission';
