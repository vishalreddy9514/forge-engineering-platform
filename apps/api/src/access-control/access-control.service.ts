import { ProjectRole } from '@forge/types';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';

import { PrismaService } from '../infrastructure/database/prisma.service';
import { REDIS_CLIENT } from '../infrastructure/redis/redis.module';

/** Where a guarded route's project comes from. */
export type ProjectScope = 'project' | 'issue' | 'sprint';

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
  async resolveProjectId(scope: ProjectScope, id: string): Promise<string | null> {
    // Malformed IDs cannot exist; answering 404 early also keeps them away from the database.
    if (!UUID.test(id)) return null;
    switch (scope) {
      case 'project': {
        const project = await this.prisma.project.findUnique({
          where: { id },
          select: { id: true },
        });
        return project?.id ?? null;
      }
      case 'issue': {
        const issue = await this.prisma.issue.findFirst({
          where: { id, deletedAt: null },
          select: { projectId: true },
        });
        return issue?.projectId ?? null;
      }
      case 'sprint': {
        const sprint = await this.prisma.sprint.findUnique({
          where: { id },
          select: { projectId: true },
        });
        return sprint?.projectId ?? null;
      }
    }
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
