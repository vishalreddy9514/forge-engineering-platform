import { Injectable, Logger } from '@nestjs/common';

import type { RequestMeta } from '../common/http/request-meta';
import type { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../infrastructure/database/prisma.service';

export interface AuditEntry {
  /** Dotted verb, e.g. "auth.login.failed", "admin.user.deactivated". */
  action: string;
  actorId?: string | null;
  entityType?: string;
  entityId?: string;
  metadata?: Prisma.InputJsonValue;
}

/**
 * Writes the append-only security audit trail (FR-13). Pass a transaction client to record the
 * entry atomically with the change it describes.
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  async record(
    entry: AuditEntry,
    meta: RequestMeta,
    tx: Prisma.TransactionClient = this.prisma,
  ): Promise<void> {
    await tx.auditLog.create({
      data: {
        action: entry.action,
        actorId: entry.actorId ?? null,
        entityType: entry.entityType ?? null,
        entityId: entry.entityId ?? null,
        metadata: entry.metadata,
        ipAddress: meta.ip,
        userAgent: meta.userAgent,
        requestId: meta.requestId,
      },
    });
    this.logger.log({ audit: entry.action, actorId: entry.actorId, entityId: entry.entityId });
  }
}
