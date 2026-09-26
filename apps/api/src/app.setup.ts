import { type INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { type NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';

import { ProblemDetailsFilter } from './common/http/problem-details.filter';
import { REQUEST_ID_HEADER } from './common/http/request-id';
import { type Env } from './config/env';

export const API_PREFIX = 'api/v1';

/**
 * Cross-cutting HTTP configuration, shared by main.ts and the e2e tests so tests exercise
 * exactly what production runs.
 */
export function configureApp(app: NestExpressApplication): INestApplication {
  const config = app.get<ConfigService<Env, true>>(ConfigService);

  app.set('trust proxy', config.get('TRUST_PROXY_HOPS', { infer: true }));
  app.disable('x-powered-by');
  app.use(helmet());
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
