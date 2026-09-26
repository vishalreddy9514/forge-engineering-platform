import { parseIssueKey, ProjectRole } from '@forge/types';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';

import { PrismaService } from '../infrastructure/database/prisma.service';
import { REDIS_CLIENT } from '../infrastructure/redis/redis.module';

/** Where a guarded route's project comes from. */
export type ProjectScope =
  'project' | 'projectKey' | 'issue' | 'issueKey' | 'comment' | 'attachment' | 'sprint' | 'label';

export interface ResolvedProject {
  id: string;
  archived: boolean;
}

const PROJECT_KEY = /^[A-Za-z][A-Za-z0-9]{1,9}$/;

const CACHE_TTL_SECONDS = 60;
const NO_MEMBERSHIP = '-';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Answers "what is this user's role in this project?" on the hot path of every project-scoped
 * request. Memberships are cached in Redis for 60 s; membership changes call `invalidate`.
 */
@Injectable()
export class AccessControlService {
  private readonly logger = new Logger(AccessControlService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  async getRole(userId: string, projectId: string): Promise<ProjectRole | null> {
    const key = this.cacheKey(projectId, userId);
    const cached = await this.redis.get(key).catch(() => null);
    if (cached !== null) return cached === NO_MEMBERSHIP ? null : ProjectRole.parse(cached);

    const membership = await this.prisma.projectMember.findUnique({
      where: { projectId_userId: { projectId, userId } },
      select: { role: { select: { key: true } } },
    });
    const role = membership ? ProjectRole.parse(membership.role.key) : null;

    await this.redis
      .set(key, role ?? NO_MEMBERSHIP, 'EX', CACHE_TTL_SECONDS)
      .catch((error: unknown) => {
        this.logger.warn({ err: error }, 'Membership cache write failed');
      });
    return role;
  }

  /** Project that owns the resource, or null if the resource does not exist (→ 404). */
  async resolveProject(scope: ProjectScope, id: string): Promise<ResolvedProject | null> {
    // Malformed IDs cannot exist; answering 404 early also keeps them away from the database.
    const keyScoped = scope === 'projectKey' || scope === 'issueKey';
    if (!keyScoped && !UUID.test(id)) return null;
    if (scope === 'projectKey' && !PROJECT_KEY.test(id)) return null;

    const select = { id: true, archivedAt: true } as const;
    let project: { id: string; archivedAt: Date | null } | null | undefined;
    switch (scope) {
      case 'project':
        project = await this.prisma.project.findUnique({ where: { id }, select });
        break;
      case 'projectKey':
        project = await this.prisma.project.findUnique({
          where: { key: id.toUpperCase() },
          select,
        });
        break;
      case 'issue':
        project = (
          await this.prisma.issue.findFirst({
            where: { id, deletedAt: null },
            select: { project: { select } },
          })
        )?.project;
        break;
      case 'issueKey': {
        const key = parseIssueKey(id);
        if (!key) return null;
        project = (
          await this.prisma.issue.findFirst({
            where: { number: key.number, deletedAt: null, project: { key: key.projectKey } },
            select: { project: { select } },
          })
        )?.project;
        break;
      }
      case 'comment':
        project = (
          await this.prisma.issueComment.findFirst({
            where: { id, deletedAt: null, issue: { deletedAt: null } },
            select: { issue: { select: { project: { select } } } },
          })
        )?.issue.project;
        break;
      case 'attachment':
        project = (
          await this.prisma.attachment.findFirst({
            where: { id, issue: { deletedAt: null } },
            select: { issue: { select: { project: { select } } } },
          })
        )?.issue.project;
        break;
      case 'sprint':
        project = (
          await this.prisma.sprint.findUnique({ where: { id }, select: { project: { select } } })
        )?.project;
        break;
      case 'label':
        project = (
          await this.prisma.label.findUnique({ where: { id }, select: { project: { select } } })
        )?.project;
        break;
    }
    return project ? { id: project.id, archived: project.archivedAt !== null } : null;
  }

  /** Every project the user can see; the permission filter for search and RAG (§7.4). */
  async accessibleProjectIds(userId: string): Promise<string[]> {
    const memberships = await this.prisma.projectMember.findMany({
      where: { userId },
      select: { projectId: true },
    });
    return memberships.map((m) => m.projectId);
  }

  async invalidate(projectId: string, userId: string): Promise<void> {
    await this.redis.del(this.cacheKey(projectId, userId)).catch(() => undefined);
  }

  private cacheKey(projectId: string, userId: string): string {
    return `acl:${projectId}:${userId}`;
  }
}
