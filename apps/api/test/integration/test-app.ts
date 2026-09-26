import { getQueueToken } from '@nestjs/bullmq';
import { Controller, Delete, Get, HttpCode, Param, Post, type Type } from '@nestjs/common';
import { type NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import type { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { once } from 'node:events';
import request from 'supertest';

import { RequireProjectPermission } from '../../src/access-control/require-project-permission.decorator';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/app.setup';
import { PrismaService } from '../../src/infrastructure/database/prisma.service';
import { QUEUES } from '../../src/infrastructure/queue/queue.module';
import { REDIS_CLIENT } from '../../src/infrastructure/redis/redis.module';

/**
 * Probe endpoints guarded exactly like real project-scoped routes will be (Phase 5+), so the
 * RBAC layer is tested end to end before any feature uses it.
 */
@Controller('_probe')
export class RbacProbeController {
  @Get('projects/:projectId')
  @RequireProjectPermission('project:read')
  read(@Param('projectId') projectId: string) {
    return { ok: true, projectId };
  }

  @Post('projects/:projectId/issues')
  @HttpCode(201)
  @RequireProjectPermission('issue:create')
  createIssue() {
    return { ok: true };
  }

  @Post('projects/:projectId/members')
  @HttpCode(201)
  @RequireProjectPermission('member:manage')
  addMember() {
    return { ok: true };
  }

  @Delete('issues/:issueId')
  @HttpCode(204)
  @RequireProjectPermission('issue:delete', 'issue')
  deleteIssue() {
    return undefined;
  }
}

export interface TestApp {
  app: NestExpressApplication;
  http: ReturnType<typeof request>;
  prisma: PrismaService;
  redis: Redis;
  emailQueue: Queue;
  close(): Promise<void>;
}

export async function createTestApp(extraControllers: Type[] = []): Promise<TestApp> {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
    controllers: extraControllers,
  }).compile();
  const app = configureApp(
    moduleRef.createNestApplication<NestExpressApplication>({ logger: false }),
  ) as NestExpressApplication;
  await app.init();

  const redis = app.get<Redis>(REDIS_CLIENT);
  // The shared client fails fast instead of queueing while it connects (see RedisModule), so
  // wait for the connection before tests talk to Redis directly.
  if (redis.status !== 'ready') await once(redis, 'ready');
  return {
    app,
    http: request(app.getHttpServer()),
    prisma: app.get(PrismaService),
    redis,
    emailQueue: app.get<Queue>(getQueueToken(QUEUES.EMAIL)),
    close: () => app.close(),
  };
}

/** Pulls the refresh cookie value out of a response's Set-Cookie headers. */
export function refreshCookie(res: request.Response): string | undefined {
  const cookies = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
  const match = cookies.map((c) => /^forge_rt=([^;]*)/.exec(c)).find(Boolean);
  return match?.[1] || undefined;
}

export function setCookieHeader(res: request.Response, name: string): string | undefined {
  return ([] as string[])
    .concat(res.headers['set-cookie'] ?? [])
    .find((c) => c.startsWith(`${name}=`));
}
