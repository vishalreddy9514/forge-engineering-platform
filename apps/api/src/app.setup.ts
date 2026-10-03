import { type INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { type NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import express from 'express';
import helmet from 'helmet';

import { ProblemDetailsFilter } from './common/http/problem-details.filter';
import { REQUEST_ID_HEADER } from './common/http/request-id';
import { type Env } from './config/env';
import { GITHUB_WEBHOOK_PATH } from './github/github-webhook.controller';

export const API_PREFIX = 'api/v1';
/**
 * Longer than any proxy in front of the API keeps an idle connection (the ALB: 120 s), so the
 * proxy, not the API, closes it. Otherwise a proxy can reuse a socket the API has just closed
 * and the request fails ("socket hang up", or a 502 from the ALB).
 */
export const KEEP_ALIVE_TIMEOUT_MS = 125_000;
const DOCUMENT_ROUTES = /^\/api\/v1\/projects\/[^/]+\/documents(?:\/[^/]+)?$/;

/**
 * Cross-cutting HTTP configuration, shared by main.ts and the e2e tests so tests exercise
 * exactly what production runs.
 */
export function configureApp(app: NestExpressApplication): INestApplication {
  const config = app.get<ConfigService<Env, true>>(ConfigService);

  const server = app.getHttpServer();
  server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
  server.headersTimeout = KEEP_ALIVE_TIMEOUT_MS + 1_000;

  app.set('trust proxy', config.get('TRUST_PROXY_HOPS', { infer: true }));
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(cookieParser());
  // Webhook signatures cover the exact bytes GitHub sent, so this route gets the raw body
  // (the JSON parser then skips it). GitHub caps payloads at 25 MB; larger ones are rare and
  // hourly reconciliation fetches whatever a rejected delivery carried.
  app.use(`/${API_PREFIX}/${GITHUB_WEBHOOK_PATH}`, express.raw({ type: () => true, limit: '5mb' }));
  // Uploaded documents are Markdown sent as JSON text, up to 1 MB of UTF-8 (MAX_DOCUMENT_BYTES)
  // plus JSON escaping; every other route keeps the default 100 kB limit.
  const documentJson = express.json({ limit: '2mb' });
  app.use((req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (DOCUMENT_ROUTES.test(req.path)) {
      documentJson(req, res, next);
      return;
    }
    next();
  });
  app.enableCors({
    origin: config.get('CORS_ORIGINS', { infer: true }),
    credentials: true,
    exposedHeaders: [REQUEST_ID_HEADER],
  });
  app.setGlobalPrefix(API_PREFIX);
  app.useGlobalFilters(new ProblemDetailsFilter());
  app.enableShutdownHooks();

  const swaggerEnabled =
    config.get('SWAGGER_ENABLED', { infer: true }) ??
    config.get('NODE_ENV', { infer: true }) !== 'production';
  if (swaggerEnabled) {
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setTitle('Forge API')
        .setDescription('REST API for the Forge engineering platform')
        .setVersion('1.0')
        .addBearerAuth()
        .build(),
    );
    SwaggerModule.setup('api/docs', app, document, { jsonDocumentUrl: 'api/docs/openapi.json' });
  }

  return app;
}
