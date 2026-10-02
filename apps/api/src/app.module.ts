import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';

import { AccessControlModule } from './access-control/access-control.module';
import { AdminModule } from './admin/admin.module';
import { AiModule } from './ai/ai.module';
import { AttachmentsModule } from './attachments/attachments.module';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { configModule, loggerModule } from './config/root-modules';
import { DashboardModule } from './dashboard/dashboard.module';
import { GithubModule } from './github/github.module';
import { HealthModule } from './health/health.module';
import { NotificationsModule } from './notifications/notifications.module';
import { ProjectsModule } from './projects/projects.module';
import { DatabaseModule } from './infrastructure/database/database.module';
import { IssuesModule } from './issues/issues.module';
import { QueueModule } from './infrastructure/queue/queue.module';
import { RedisModule } from './infrastructure/redis/redis.module';
import { StorageModule } from './infrastructure/storage/storage.module';
import { RateLimitGuard } from './rate-limit/rate-limit.guard';
import { SearchModule } from './search/search.module';
import { RateLimitModule } from './rate-limit/rate-limit.module';
import { SprintsModule } from './sprints/sprints.module';
import { UsersModule } from './users/users.module';

@Module({
  imports: [
    configModule(),
    loggerModule('api'),
    DatabaseModule,
    RedisModule,
    StorageModule,
    QueueModule.forRoot('producer'),
    RateLimitModule,
    AuditModule,
    AccessControlModule,
    AuthModule,
    UsersModule,
    AdminModule,
    ProjectsModule,
    IssuesModule,
    AttachmentsModule,
    SprintsModule,
    DashboardModule,
    GithubModule,
    AiModule,
    SearchModule,
    NotificationsModule,
    HealthModule,
  ],
  providers: [
    // Order matters: authenticate first, so rate limits can count per user.
    { provide: APP_GUARD, useExisting: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RateLimitGuard },
  ],
})
export class AppModule {}
