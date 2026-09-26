import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';

import type { AuthenticatedRequest } from '../auth/auth.types';
import { PrismaService } from '../infrastructure/database/prisma.service';

/**
 * Admin-only routes re-check the database instead of trusting the token's `adm` claim, so a
 * demoted or deactivated admin loses access immediately, not when their token expires.
 */
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const { user } = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const current = await this.prisma.user.findUnique({
      where: { id: user.id },
      select: { isAdmin: true, isActive: true },
    });
    if (!current?.isAdmin || !current.isActive) {
      throw new ForbiddenException('Administrator access required');
    }
    return true;
  }
}
