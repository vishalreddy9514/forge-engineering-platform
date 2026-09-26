import { type NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { REDIS_CLIENT } from '../src/infrastructure/redis/redis.module';

describe('API (e2e)', () => {
  let app: NestExpressApplication;
  const redis = { ping: jest.fn(), status: 'ready', quit: jest.fn(), disconnect: jest.fn() };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(REDIS_CLIENT)
      .useValue(redis)
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
    redis.ping.mockReset();
  });

  describe('GET /api/v1/health/live', () => {
    it('returns 200 without touching dependencies', async () => {
      await request(app.getHttpServer())
        .get('/api/v1/health/live')
        .expect(200)
        .expect({ status: 'ok' });
      expect(redis.ping).not.toHaveBeenCalled();
    });
  });

  describe('GET /api/v1/health/ready', () => {
    it('returns 200 when Redis answers', async () => {
      redis.ping.mockResolvedValue('PONG');
      const res = await request(app.getHttpServer()).get('/api/v1/health/ready').expect(200);
      expect(res.body).toEqual({ status: 'ok', checks: { redis: { status: 'ok' } } });
    });

    it('returns 503 and names the failing dependency when Redis is down', async () => {
      redis.ping.mockRejectedValue(new Error('Connection is closed.'));
      const res = await request(app.getHttpServer()).get('/api/v1/health/ready').expect(503);
      expect(res.body).toEqual({
        status: 'error',
        checks: { redis: { status: 'error', message: 'Connection is closed.' } },
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

    it('serves the OpenAPI document', async () => {
      const res = await request(app.getHttpServer()).get('/api/docs/openapi.json').expect(200);
      expect(res.body.paths).toHaveProperty('/api/v1/health/ready');
    });
  });
});
