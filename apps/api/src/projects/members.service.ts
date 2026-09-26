import type { AddMemberRequest, ProjectMember, ProjectRole } from '@forge/types';
import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { AccessControlService } from '../access-control/access-control.service';
import type { ProjectAccess } from '../access-control/project-access.guard';
import { can } from '../access-control/permissions';
import { AuditService } from '../audit/audit.service';
import type { AuthUser } from '../auth/auth.types';
import type { RequestMeta } from '../common/http/request-meta';
import type { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../infrastructure/database/prisma.service';
import { MEMBER_INCLUDE, toProjectMember } from './project.mappers';

const ROLE_ORDER: Record<ProjectRole, number> = { PROJECT_MANAGER: 0, DEVELOPER: 1, VIEWER: 2 };

@Injectable()
export class MembersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessControlService,
    private readonly audit: AuditService,
  ) {}

  async list(projectId: string): Promise<ProjectMember[]> {
    const members = await this.prisma.projectMember.findMany({
      where: { projectId },
      include: MEMBER_INCLUDE,
    });
    return members
      .map(toProjectMember)
      .sort(
        (a, b) =>
          ROLE_ORDER[a.role] - ROLE_ORDER[b.role] ||
          a.user.displayName.localeCompare(b.user.displayName),
      );
  }

  async add(
    projectId: string,
    input: AddMemberRequest,
    actor: AuthUser,
    meta: RequestMeta,
  ): Promise<ProjectMember> {
    const user = await this.prisma.user.findUnique({ where: { email: input.email } });
    if (!user?.isActive) {
      throw new NotFoundException({
        message: 'Validation failed',
        errors: [{ path: 'email', message: 'No active user has this email address' }],
      });
    }

    try {
      const member = await this.prisma.$transaction(async (tx) => {
        const created = await tx.projectMember.create({
          data: {
            projectId,
            userId: user.id,
            addedById: actor.id,
            roleId: await this.roleId(tx, input.role),
          },
          include: MEMBER_INCLUDE,
        });
        await this.audit.record(
          {
            action: 'project.member.added',
            actorId: actor.id,
            entityType: 'project',
            entityId: projectId,
            metadata: { userId: user.id, role: input.role },
          },
          meta,
          tx,
        );
        return created;
      });
      await this.access.invalidate(projectId, user.id);
      return toProjectMember(member);
    } catch (error) {
      if ((error as { code?: string }).code === 'P2002') {
        throw new ConflictException({
          message: 'Validation failed',
          errors: [{ path: 'email', message: 'This person is already a member' }],
        });
      }
      throw error;
    }
  }

  async changeRole(
    projectId: string,
    userId: string,
    role: ProjectRole,
    actor: AuthUser,
    meta: RequestMeta,
  ): Promise<ProjectMember> {
    const member = await this.prisma.$transaction(async (tx) => {
      const current = await this.lockedMembership(tx, projectId, userId);
      if (current.role.key === 'PROJECT_MANAGER' && role !== 'PROJECT_MANAGER') {
        await this.assertAnotherManager(tx, projectId, userId);
      }
      const updated = await tx.projectMember.update({
        where: { projectId_userId: { projectId, userId } },
        data: { roleId: await this.roleId(tx, role) },
        include: MEMBER_INCLUDE,
      });
      await this.audit.record(
        {
          action: 'project.member.role_changed',
          actorId: actor.id,
          entityType: 'project',
          entityId: projectId,
          metadata: { userId, from: current.role.key, to: role },
        },
        meta,
        tx,
      );
      return updated;
    });
    await this.access.invalidate(projectId, userId);
    return toProjectMember(member);
  }

  /** Managers remove anyone; every member may remove themselves (leave the project). */
  async remove(
    projectId: string,
    userId: string,
    actor: AuthUser,
    actorAccess: ProjectAccess,
    meta: RequestMeta,
  ): Promise<void> {
    const leaving = userId === actor.id;
    if (!leaving && !can(actorAccess.role, 'member:manage')) {
      throw new ForbiddenException('Only project managers can remove other members');
    }

    await this.prisma.$transaction(async (tx) => {
      const current = await this.lockedMembership(tx, projectId, userId);
      if (current.role.key === 'PROJECT_MANAGER') {
        await this.assertAnotherManager(tx, projectId, userId);
      }
      await tx.projectMember.delete({ where: { projectId_userId: { projectId, userId } } });
      await this.audit.record(
        {
          action: leaving ? 'project.member.left' : 'project.member.removed',
          actorId: actor.id,
          entityType: 'project',
          entityId: projectId,
          metadata: { userId, role: current.role.key },
        },
        meta,
        tx,
      );
    });
    // Access ends now, not when the 60 s membership cache would have expired.
    await this.access.invalidate(projectId, userId);
  }

  /**
   * Locks the project row first, so concurrent membership changes in one project run one at a
   * time. Without it, two managers demoting each other at the same moment could both see
   * "another manager exists" and leave the project with none.
   */
  private async lockedMembership(tx: Prisma.TransactionClient, projectId: string, userId: string) {
    await tx.$queryRaw`SELECT id FROM projects WHERE id = ${projectId}::uuid FOR UPDATE`;
    const membership = await tx.projectMember.findUnique({
      where: { projectId_userId: { projectId, userId } },
      select: { role: { select: { key: true } } },
    });
    if (!membership) throw new NotFoundException('Member not found');
    return membership;
  }

  private async assertAnotherManager(
    tx: Prisma.TransactionClient,
    projectId: string,
    exceptUserId: string,
  ): Promise<void> {
    const others = await tx.projectMember.count({
      where: { projectId, userId: { not: exceptUserId }, role: { key: 'PROJECT_MANAGER' } },
    });
    if (others === 0) {
      throw new ConflictException(
        'A project needs at least one project manager. Promote someone else first.',
      );
    }
  }

  private async roleId(tx: Prisma.TransactionClient, role: ProjectRole): Promise<number> {
    const row = await tx.role.findUniqueOrThrow({ where: { key: role }, select: { id: true } });
    return row.id;
  }
}
