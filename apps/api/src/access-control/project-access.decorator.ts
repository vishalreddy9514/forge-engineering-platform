import { createParamDecorator, type ExecutionContext } from '@nestjs/common';

import type { ProjectAccess, ProjectScopedRequest } from './project-access.guard';

/** The project and effective role resolved by ProjectAccessGuard for this request. */
export const CurrentProjectAccess = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): ProjectAccess =>
    ctx.switchToHttp().getRequest<ProjectScopedRequest>().projectAccess,
);
