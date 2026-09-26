import { createParamDecorator, type ExecutionContext, SetMetadata } from '@nestjs/common';

import type { AuthenticatedRequest, AuthUser } from './auth.types';

export const IS_PUBLIC_KEY = 'isPublic';

/** Opt a route out of the global access-token requirement. */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

/** The authenticated caller (only on non-public routes). */
export const CurrentUser = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): AuthUser =>
    ctx.switchToHttp().getRequest<AuthenticatedRequest>().user,
);
