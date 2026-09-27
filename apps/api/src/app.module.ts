import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';

import { AccessControlModule } from './access-control/access-control.module';
import { AdminModule } from './admin/admin.module';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { configModule, loggerModule } from './config/root-modules';
import { HealthModule } from './health/health.module';
import { ProjectsModule } from './projects/projects.module';
import { DatabaseModule } from './infrastructure/database/database.module';
import { IssuesModule } from './issues/issues.module';
import { QueueModule } from './infrastructure/queue/queue.module';
import { RedisModule } from './infrastructure/redis/redis.module';
import { RateLimitGuard } from './rate-limit/rate-limit.guard';
import { RateLimitModule } from './rate-limit/rate-limit.module';
import { UsersModule } from './users/users.module';

@Module({
  imports: [
    configModule(),
    loggerModule('api'),
    DatabaseModule,
    RedisModule,
    QueueModule.forRoot('producer'),
    RateLimitModule,
    AuditModule,
    AccessControlModule,
    AuthModule,
    UsersModule,
    AdminModule,
    ProjectsModule,
    IssuesModule,
    HealthModule,
  ],
  providers: [
    // Order matters: authenticate first, so rate limits can count per user.
    { provide: APP_GUARD, useExisting: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RateLimitGuard },
  ],
})
export class AppModule {}
