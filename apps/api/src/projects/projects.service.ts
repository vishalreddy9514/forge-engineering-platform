import type {
  CreateProjectRequest,
  CursorPage,
  ListProjectsQuery,
  ProjectDetail,
  ProjectSummary,
  UpdateProjectRequest,
} from '@forge/types';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { AuditService } from '../audit/audit.service';
import type { AuthUser } from '../auth/auth.types';
import { decodeCursorParts, encodeCursorParts } from '../common/http/cursor';
import type { RequestMeta } from '../common/http/request-meta';
import type { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../infrastructure/database/prisma.service';
import { OPEN_ISSUES } from '../issues/open-issues';
import {
  type ProjectCounts,
  projectDetailInclude,
  projectSummaryInclude,
  toProjectDetail,
  toProjectSummary,
} from './project.mappers';

@Injectable()
export class ProjectsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Projects the caller belongs to (platform admins see every project), alphabetical. */
  async list(user: AuthUser, query: ListProjectsQuery): Promise<CursorPage<ProjectSummary>> {
    const after = query.cursor ? decodeCursorParts(query.cursor, 2) : undefined;
    const filters: Prisma.ProjectWhereInput[] = [
      { archivedAt: query.archived ? { not: null } : null },
    ];
    if (!user.isAdmin) filters.push({ members: { some: { userId: user.id } } });
    if (query.q) {
      filters.push({
        OR: [
          { name: { contains: query.q, mode: 'insensitive' } },
          { key: { startsWith: query.q.toUpperCase() } },
        ],
      });
    }
    if (after) {
      const [name = '', id = ''] = after;
      filters.push({ OR: [{ name: { gt: name } }, { name, id: { gt: id } }] });
    }

    const rows = await this.prisma.project.findMany({
      where: { AND: filters },
      include: projectSummaryInclude(user.id),
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      take: query.limit + 1,
    });
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    const counts = await this.counts(page.map((project) => project.id));
    return {
      data: page.map((project) => toProjectSummary(project, countsOf(counts, project.id))),
      nextCursor: rows.length > query.limit && last ? encodeCursorParts(last.name, last.id) : null,
    };
  }

  async get(projectId: string, user: AuthUser): Promise<ProjectDetail> {
    const [project, counts] = await Promise.all([
      this.prisma.project.findUniqueOrThrow({
        where: { id: projectId },
        include: projectDetailInclude(user.id),
      }),
      this.counts([projectId]),
    ]);
    return toProjectDetail(project, countsOf(counts, projectId));
  }

  /** Members and open issues of these projects only (index ranges, not whole-table groups). */
  private async counts(projectIds: string[]): Promise<Map<string, ProjectCounts>> {
    if (projectIds.length === 0) return new Map();
    const [members, open] = await Promise.all([
      this.prisma.projectMember.groupBy({
        by: ['projectId'],
        where: { projectId: { in: projectIds } },
        _count: { _all: true },
      }),
      this.prisma.issue.groupBy({
        by: ['projectId'],
        where: { projectId: { in: projectIds }, ...OPEN_ISSUES },
        _count: { _all: true },
      }),
    ]);
    const counts = new Map<string, ProjectCounts>();
    for (const row of members)
      counts.set(row.projectId, { members: row._count._all, openIssues: 0 });
    for (const row of open) {
      const entry = counts.get(row.projectId) ?? { members: 0, openIssues: 0 };
      counts.set(row.projectId, { ...entry, openIssues: row._count._all });
    }
    return counts;
  }

  /** The creator becomes the first project manager, in the same transaction. */
  async create(
    input: CreateProjectRequest,
    user: AuthUser,
    meta: RequestMeta,
  ): Promise<ProjectDetail> {
    try {
      const project = await this.prisma.$transaction(async (tx) => {
        const created = await tx.project.create({
          data: {
            key: input.key,
            name: input.name,
            description: input.description ?? null,
            createdById: user.id,
            members: {
              create: {
                user: { connect: { id: user.id } },
                role: { connect: { key: 'PROJECT_MANAGER' } },
              },
            },
          },
        });
        await this.audit.record(
          {
            action: 'project.created',
            actorId: user.id,
            entityType: 'project',
            entityId: created.id,
            metadata: { key: created.key },
          },
          meta,
          tx,
        );
        return created;
      });
      return await this.get(project.id, user);
    } catch (error) {
      if ((error as { code?: string }).code === 'P2002') {
        throw new ConflictException({
          message: 'Validation failed',
          errors: [{ path: 'key', message: `The key ${input.key} is already taken` }],
        });
      }
      throw error;
    }
  }

  async update(
    projectId: string,
    input: UpdateProjectRequest,
    user: AuthUser,
    meta: RequestMeta,
  ): Promise<ProjectDetail> {
    if (input.defaultAssigneeId) {
      const member = await this.prisma.projectMember.findUnique({
        where: { projectId_userId: { projectId, userId: input.defaultAssigneeId } },
      });
      if (!member) {
        throw new BadRequestException({
          message: 'Validation failed',
          errors: [
            { path: 'defaultAssigneeId', message: 'The default assignee must be a project member' },
          ],
        });
      }
    }

    await this.prisma.$transaction(async (tx) => {
      const before = await tx.project.findUniqueOrThrow({ where: { id: projectId } });
      // Forms send every field; the audit trail should name only what actually changed.
      const changed = (Object.keys(input) as (keyof UpdateProjectRequest)[]).filter(
        (field) => input[field] !== undefined && input[field] !== before[field],
      );
      if (changed.length === 0) return;

      await tx.project.update({ where: { id: projectId }, data: input });
      await this.audit.record(
        {
          action: 'project.updated',
          actorId: user.id,
          entityType: 'project',
          entityId: projectId,
          metadata: { fields: changed },
        },
        meta,
        tx,
      );
    });
    return this.get(projectId, user);
  }

  /** Idempotent: archiving an archived project (or restoring an active one) changes nothing. */
  async setArchived(
    projectId: string,
    archived: boolean,
    user: AuthUser,
    meta: RequestMeta,
  ): Promise<ProjectDetail> {
    const changed = await this.prisma.project.updateMany({
      where: { id: projectId, archivedAt: archived ? null : { not: null } },
      data: { archivedAt: archived ? new Date() : null },
    });
    if (changed.count > 0) {
      await this.audit.record(
        {
          action: archived ? 'project.archived' : 'project.restored',
          actorId: user.id,
          entityType: 'project',
          entityId: projectId,
        },
        meta,
      );
    }
    return this.get(projectId, user);
  }

  /**
   * Permanent deletion (admins only). Two safety catches against deleting the wrong project:
   * it must be archived first, and the caller must repeat its key.
   */
  async delete(
    projectId: string,
    confirmKey: string | undefined,
    user: AuthUser,
    meta: RequestMeta,
  ) {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project) throw new NotFoundException('Project not found');
    if (!project.archivedAt) {
      throw new ConflictException('Archive the project before deleting it');
    }
    if (confirmKey?.toUpperCase() !== project.key) {
      throw new BadRequestException(`Confirm by passing ?confirm=${project.key}`);
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.project.delete({ where: { id: projectId } });
      await this.audit.record(
        {
          action: 'project.deleted',
          actorId: user.id,
          entityType: 'project',
          entityId: projectId,
          metadata: { key: project.key, name: project.name },
        },
        meta,
        tx,
      );
    });
  }
}

const countsOf = (counts: Map<string, ProjectCounts>, projectId: string): ProjectCounts =>
  counts.get(projectId) ?? { members: 0, openIssues: 0 };
