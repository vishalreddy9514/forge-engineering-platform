import {
  type CursorPage,
  type ListNotificationsQuery,
  Notification,
  type UnreadCount,
} from '@forge/types';
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';

import type { Notification as NotificationRow } from '../generated/prisma/client';
import { PrismaService } from '../infrastructure/database/prisma.service';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function toNotification(row: NotificationRow): Notification {
  // The payload is written by the worker in this shape; parsing guards the contract anyway.
  return Notification.parse({
    id: row.id,
    type: row.type,
    payload: row.payload,
    readAt: row.readAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  });
}

/** The caller's own notifications (FR-12.2). Other users' notifications are never visible. */
@Injectable()
export class NotificationsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Newest first. IDs are UUIDv7 (time-ordered), so the ID alone is a stable keyset cursor. */
  async list(userId: string, query: ListNotificationsQuery): Promise<CursorPage<Notification>> {
    const cursor = query.cursor ? Buffer.from(query.cursor, 'base64url').toString('utf8') : null;
    if (cursor !== null && !UUID.test(cursor)) throw new BadRequestException('Invalid cursor');

    const rows = await this.prisma.notification.findMany({
      where: {
        userId,
        ...(query.unread ? { readAt: null } : {}),
        ...(cursor ? { id: { lt: cursor } } : {}),
      },
      orderBy: { id: 'desc' },
      take: query.limit + 1,
    });
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      data: page.map(toNotification),
      nextCursor:
        rows.length > query.limit && last ? Buffer.from(last.id).toString('base64url') : null,
    };
  }

  async unreadCount(userId: string): Promise<UnreadCount> {
    const count = await this.prisma.notification.count({ where: { userId, readAt: null } });
    return { count };
  }

  /** Idempotent. Someone else's notification answers 404, exactly like a missing one. */
  async markRead(userId: string, notificationId: string): Promise<void> {
    if (!UUID.test(notificationId)) throw new NotFoundException('Notification not found');
    const { count } = await this.prisma.notification.updateMany({
      where: { id: notificationId, userId, readAt: null },
      data: { readAt: new Date() },
    });
    if (count === 0) {
      const exists = await this.prisma.notification.count({
        where: { id: notificationId, userId },
      });
      if (exists === 0) throw new NotFoundException('Notification not found');
    }
  }

  async markAllRead(userId: string): Promise<void> {
    await this.prisma.notification.updateMany({
      where: { userId, readAt: null },
      data: { readAt: new Date() },
    });
  }
}
