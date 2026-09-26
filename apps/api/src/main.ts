import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { type NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from 'nestjs-pino';

import { AppModule } from './app.module';
import { configureApp } from './app.setup';
import { type Env } from './config/env';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  configureApp(app);

  const port = app.get<ConfigService<Env, true>>(ConfigService).get('API_PORT', { infer: true });
  await app.listen(port, '0.0.0.0');
  app.get(Logger).log(`API listening on port ${port}`, 'Bootstrap');
}

bootstrap().catch((error: unknown) => {
  // The logger may not exist yet (e.g. invalid configuration), so write to stderr directly.
  // eslint-disable-next-line no-console
  console.error(error);
  process.exit(1);
});
