import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import type { AuthenticatedRequest } from '../auth/auth.types';
import { AccessControlService } from './access-control.service';
import { can, type EffectiveRole } from './permissions';
import {
  PROJECT_PERMISSION_KEY,
  type ProjectPermissionRequirement,
} from './project-permission.metadata';

export interface ProjectAccess {
  projectId: string;
  role: EffectiveRole;
}

export type ProjectScopedRequest = AuthenticatedRequest & { projectAccess: ProjectAccess };

@Injectable()
export class ProjectAccessGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly access: AccessControlService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requirement = this.reflector.get<ProjectPermissionRequirement | undefined>(
      PROJECT_PERMISSION_KEY,
      context.getHandler(),
    );
    if (!requirement) return true;

    const req = context.switchToHttp().getRequest<ProjectScopedRequest>();
    const resourceId = req.params[requirement.param];
    const notFound = () => new NotFoundException(`${capitalise(requirement.scope)} not found`);

    const projectId =
      typeof resourceId === 'string'
        ? await this.access.resolveProjectId(requirement.scope, resourceId)
        : null;
    if (!projectId) throw notFound();

    const role: EffectiveRole | null = req.user.isAdmin
      ? 'ADMIN'
      : await this.access.getRole(req.user.id, projectId);
    // Same answer as "does not exist": outsiders cannot probe which IDs are real.
    if (!role) throw notFound();
    if (!can(role, requirement.permission)) {
      throw new ForbiddenException(`Your role in this project cannot ${requirement.permission}`);
    }

    req.projectAccess = { projectId, role };
    return true;
  }
}

function capitalise(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
