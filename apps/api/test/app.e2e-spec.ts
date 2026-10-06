import { getQueueToken } from '@nestjs/bullmq';
import { type NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PrismaService } from '../src/infrastructure/database/prisma.service';
import { QUEUES } from '../src/infrastructure/queue/queue.module';
import { REDIS_CLIENT } from '../src/infrastructure/redis/redis.module';
import { registry } from '../src/observability/metrics';

describe('API (e2e)', () => {
  let app: NestExpressApplication;
  // HTTP-level tests replace the two infrastructure clients; the real database is exercised by
  // the integration suite (test/integration).
  const redis = {
    ping: jest.fn(),
    // Rate limiter (atomic counter script) and revocation lookups.
    eval: jest.fn().mockResolvedValue([1, 60_000]),
    get: jest.fn().mockResolvedValue(null),
    status: 'ready',
    quit: jest.fn(),
    disconnect: jest.fn(),
  };
  const prisma = { $queryRaw: jest.fn(), $connect: jest.fn(), $disconnect: jest.fn() };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(REDIS_CLIENT)
      .useValue(redis)
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .overrideProvider(getQueueToken(QUEUES.EMAIL))
      .useValue({ add: jest.fn(), close: jest.fn() })
      .compile();

    app = configureApp(
      moduleRef.createNestApplication<NestExpressApplication>({ logger: false }),
    ) as NestExpressApplication;
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    redis.ping.mockReset().mockResolvedValue('PONG');
    prisma.$queryRaw.mockReset().mockResolvedValue([{ '?column?': 1 }]);
  });

  describe('HTTP server', () => {
    it('keeps idle connections open longer than the proxy in front of it', () => {
      // A proxy that reuses a keep-alive connection the API has just closed gets "socket hang
      // up" (Next.js's dev rewrite) or a 502 (the ALB, idle timeout 120 s).
      const server = app.getHttpServer();
      expect(server.keepAliveTimeout).toBeGreaterThan(120_000);
      expect(server.headersTimeout).toBeGreaterThan(server.keepAliveTimeout);
    });
  });

  describe('request metrics and IDs', () => {
    const count = async (labels: Record<string, string>) => {
      const metric = (await registry.getMetricsAsJSON()).find(
        (m) => m.name === 'forge_http_request_duration_seconds',
      );
      return (metric?.values ?? [])
        .filter((v) => (v as { metricName?: string }).metricName?.endsWith('_count'))
        .filter((v) => Object.entries(labels).every(([k, want]) => v.labels[k] === want))
        .reduce((sum, v) => sum + v.value, 0);
    };

    it('records each request by route template and status, and reuses a safe upstream ID', async () => {
      registry.resetMetrics();
      const res = await request(app.getHttpServer())
        .get('/api/v1/health/live')
        .set('X-Request-ID', 'alb-trace-1')
        .expect(200);
      expect(res.headers['x-request-id']).toBe('alb-trace-1');
      await request(app.getHttpServer()).get('/api/v1/no-such-route/12345').expect(404);

      expect(await count({ route: '/api/v1/health/live', method: 'GET', status: '200' })).toBe(1);
      // Unknown paths share one series, so scanners cannot create unbounded label values.
      expect(await count({ route: 'unmatched', status: '404' })).toBe(1);
    });

    it('mints an ID when the upstream one is unsafe to log', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/health/live')
        .set('X-Request-ID', 'spaces and <angle> brackets')
        .expect(200);
      expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    });
  });

  describe('GET /api/v1/health/live', () => {
    it('returns 200 without touching dependencies', async () => {
      await request(app.getHttpServer())
        .get('/api/v1/health/live')
        .expect(200)
        .expect({ status: 'ok' });
      expect(redis.ping).not.toHaveBeenCalled();
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
    });
  });

  describe('GET /api/v1/health/ready', () => {
    it('returns 200 when the database and Redis answer', async () => {
      const res = await request(app.getHttpServer()).get('/api/v1/health/ready').expect(200);
      expect(res.body).toEqual({
        status: 'ok',
        checks: { database: { status: 'ok' }, redis: { status: 'ok' } },
      });
    });

    it('returns 503 when the database is down', async () => {
      prisma.$queryRaw.mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:5432'));
      const res = await request(app.getHttpServer()).get('/api/v1/health/ready').expect(503);
      expect(res.body.checks).toEqual({
        database: { status: 'error', message: 'Unavailable' },
        redis: { status: 'ok' },
      });
    });

    it('returns 503 and names the failing dependency (not the error) when Redis is down', async () => {
      redis.ping.mockRejectedValue(new Error('Connection is closed.'));
      const res = await request(app.getHttpServer()).get('/api/v1/health/ready').expect(503);
      expect(res.body).toEqual({
        status: 'error',
        checks: {
          database: { status: 'ok' },
          redis: { status: 'error', message: 'Unavailable' },
        },
      });
    });
  });

  describe('cross-cutting HTTP behaviour', () => {
    it('answers unknown routes with problem+json carrying the request ID', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/does-not-exist')
        .set('x-request-id', 'test-req-42')
        .expect(404)
        .expect('content-type', /application\/problem\+json/)
        .expect('x-request-id', 'test-req-42');

      expect(res.body).toMatchObject({
        status: 404,
        title: 'Not Found',
        instance: '/api/v1/does-not-exist',
        requestId: 'test-req-42',
      });
    });

    it('generates a request ID when the caller sends none', async () => {
      const res = await request(app.getHttpServer()).get('/api/v1/health/live');
      expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('sets secure headers and hides the framework', async () => {
      const res = await request(app.getHttpServer()).get('/api/v1/health/live');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['strict-transport-security']).toBeDefined();
      expect(res.headers['content-security-policy']).toBeDefined();
      expect(res.headers['x-powered-by']).toBeUndefined();
    });

    it('forbids caching any API response (ASVS 8.2.1)', async () => {
      const ok = await request(app.getHttpServer()).get('/api/v1/health/live');
      const missing = await request(app.getHttpServer()).get('/api/v1/does-not-exist');
      expect(ok.headers['cache-control']).toBe('no-store');
      expect(missing.headers['cache-control']).toBe('no-store');
    });

    it('allows CORS only for configured origins', async () => {
      const allowed = await request(app.getHttpServer())
        .options('/api/v1/health/live')
        .set('Origin', 'http://localhost:3000')
        .set('Access-Control-Request-Method', 'GET');
      expect(allowed.headers['access-control-allow-origin']).toBe('http://localhost:3000');

      const denied = await request(app.getHttpServer())
        .options('/api/v1/health/live')
        .set('Origin', 'https://evil.example')
        .set('Access-Control-Request-Method', 'GET');
      expect(denied.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('requires a bearer token on every route that is not explicitly public', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/users/me')
        .expect(401)
        .expect('www-authenticate', 'Bearer');
      expect(res.body).toMatchObject({ status: 401, detail: 'Missing bearer token' });
    });

    it('rejects a forged token', async () => {
      const forged = [
        Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url'),
        Buffer.from(JSON.stringify({ sub: 'someone', adm: true })).toString('base64url'),
        '',
      ].join('.');
      await request(app.getHttpServer())
        .get('/api/v1/users/me')
        .set('Authorization', `Bearer ${forged}`)
        .expect(401);
    });

    it('rejects validation errors with field-level problem details', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/register')
        .send({ email: 'not-an-email', displayName: '', password: 'short' })
        .expect(400);
      expect(res.body.errors.map((e: { path: string }) => e.path).sort()).toEqual([
        'displayName',
        'email',
        'password',
      ]);
    });

    it('reports rate-limit headers and answers 429 with Retry-After when exceeded', async () => {
      redis.eval.mockResolvedValueOnce([11, 42_000]);
      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: 'a@b.co', password: 'x' })
        .expect(429);
      expect(res.headers['retry-after']).toBe('42');
      expect(res.headers['ratelimit-limit']).toBe('10');
      expect(res.headers['ratelimit-remaining']).toBe('0');
    });

    it('serves the OpenAPI document', async () => {
      const res = await request(app.getHttpServer()).get('/api/docs/openapi.json').expect(200);
      expect(res.body.paths).toHaveProperty('/api/v1/health/ready');
    });
  });
});
