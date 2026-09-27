import { Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '../infrastructure/database/prisma.service';
import { StorageService } from '../infrastructure/storage/storage.service';

/** Uploads not confirmed within this window are abandoned (the upload URL lasts 10 minutes). */
export const PENDING_UPLOAD_MAX_AGE_MS = 60 * 60 * 1000;
const BATCH = 500;

/** Worker job: removes abandoned uploads, from storage first and then from the database. */
@Injectable()
export class AttachmentCleanup {
  private readonly logger = new Logger(AttachmentCleanup.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  async removeAbandonedUploads(now = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - PENDING_UPLOAD_MAX_AGE_MS);
    let removed = 0;
    for (;;) {
      const stale = await this.prisma.attachment.findMany({
        where: { status: 'PENDING_UPLOAD', createdAt: { lt: cutoff } },
        select: { id: true, storageKey: true },
        take: BATCH,
      });
      if (stale.length === 0) break;
      await this.storage.deleteMany(stale.map((a) => a.storageKey));
      const { count } = await this.prisma.attachment.deleteMany({
        where: { id: { in: stale.map((a) => a.id) }, status: 'PENDING_UPLOAD' },
      });
      removed += count;
      if (stale.length < BATCH) break;
    }
    if (removed > 0) this.logger.log({ removed }, 'Removed abandoned uploads');
    return removed;
  }
}
