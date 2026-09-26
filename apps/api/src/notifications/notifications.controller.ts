import {
  type CursorPage,
  ListNotificationsQuery,
  type Notification,
  type UnreadCount,
} from '@forge/types';
import { Controller, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import type { AuthUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators';
import { ZodQuery } from '../common/http/zod';
import { NotificationsService } from './notifications.service';

@ApiTags('notifications')
@ApiBearerAuth()
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  list(
    @ZodQuery(ListNotificationsQuery) query: ListNotificationsQuery,
    @CurrentUser() user: AuthUser,
  ): Promise<CursorPage<Notification>> {
    return this.notifications.list(user.id, query);
  }

  /** Polled by the header badge; one indexed count (partial index on unread rows). */
  @Get('unread-count')
  unreadCount(@CurrentUser() user: AuthUser): Promise<UnreadCount> {
    return this.notifications.unreadCount(user.id);
  }

  @Post('read-all')
  @HttpCode(HttpStatus.NO_CONTENT)
  async markAllRead(@CurrentUser() user: AuthUser): Promise<void> {
    await this.notifications.markAllRead(user.id);
  }

  @Post(':notificationId/read')
  @HttpCode(HttpStatus.NO_CONTENT)
  async markRead(
    @Param('notificationId') notificationId: string,
    @CurrentUser() user: AuthUser,
  ): Promise<void> {
    await this.notifications.markRead(user.id, notificationId);
  }
}
