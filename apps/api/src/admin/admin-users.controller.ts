import { AdminUpdateUserRequest, type AdminUser, type CursorPage } from '@forge/types';
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';

import { AuditService } from '../audit/audit.service';
import type { AuthUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators';
import { RefreshTokenService } from '../auth/refresh-token.service';
import { SessionRevocationService } from '../auth/session-revocation.service';
import { toAdminUser } from '../auth/user-profile.mapper';
import { decodeCursor, encodeCursor } from '../common/http/cursor';
import { ReqMeta, type RequestMeta } from '../common/http/request-meta';
import { ApiZodBody, ZodValidationPipe } from '../common/http/zod';
import { PrismaService } from '../infrastructure/database/prisma.service';
import { AdminGuard } from './admin.guard';

const ListUsersQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().max(200).optional(),
  q: z.string().trim().max(100).optional(),
});
type ListUsersQuery = z.infer<typeof ListUsersQuery>;

/** User administration (FR-2.1). */
@ApiTags('admin')
@ApiBearerAuth()
@UseGuards(AdminGuard)
@Controller('admin/users')
export class AdminUsersController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly refreshTokens: RefreshTokenService,
    private readonly revocation: SessionRevocationService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  async list(
    @Query(new ZodValidationPipe(ListUsersQuery)) query: ListUsersQuery,
  ): Promise<CursorPage<AdminUser>> {
    const after = query.cursor ? decodeCursor(query.cursor) : undefined;
    const rows = await this.prisma.user.findMany({
      where: {
        ...(query.q
          ? {
              OR: [
                { email: { contains: query.q, mode: 'insensitive' } },
                { displayName: { contains: query.q, mode: 'insensitive' } },
              ],
            }
          : {}),
        // Keyset pagination: rows strictly after the cursor in (createdAt DESC, id DESC) order.
        ...(after
          ? {
              AND: [
                {
                  OR: [
                    { createdAt: { lt: after.createdAt } },
                    { createdAt: after.createdAt, id: { lt: after.id } },
                  ],
                },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
    });

    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      data: page.map(toAdminUser),
      nextCursor: rows.length > query.limit && last ? encodeCursor(last.createdAt, last.id) : null,
    };
  }

  @Patch(':id')
  @ApiZodBody(AdminUpdateUserRequest)
  async update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(AdminUpdateUserRequest)) body: AdminUpdateUserRequest,
    @CurrentUser() admin: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ): Promise<AdminUser> {
    // Prevents an admin from locking themselves (and possibly everyone) out.
    if (id === admin.id) throw new BadRequestException('You cannot change your own admin status');

    const existing = await this.prisma.user.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('User not found');

    const updated = await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.update({ where: { id }, data: body });
      if (body.isActive === false) await this.refreshTokens.revokeAllForUser(id, tx);
      await this.audit.record(
        {
          action: 'admin.user.updated',
          actorId: admin.id,
          entityType: 'user',
          entityId: id,
          metadata: {
            before: { isActive: existing.isActive, isAdmin: existing.isAdmin },
            after: { isActive: user.isActive, isAdmin: user.isAdmin },
          },
        },
        meta,
        tx,
      );
      return user;
    });

    // After commit, void the user's current access tokens: a deactivated user is cut off now,
    // and a promoted/demoted user's next refresh yields a token with the new admin claim.
    const statusChanged = body.isActive !== undefined && body.isActive !== existing.isActive;
    const adminChanged = body.isAdmin !== undefined && body.isAdmin !== existing.isAdmin;
    if (statusChanged || adminChanged) await this.revocation.revokeExistingAccessTokens(id);
    return toAdminUser(updated);
  }
}
