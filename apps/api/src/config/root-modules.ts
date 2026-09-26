import { ConfigModule, ConfigService } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';

import { resolveRequestId } from '../common/http/request-id';
import { type Env, validateEnv } from './env';

/** Configuration and logging shared by both processes (API and worker). */
export function configModule() {
  return ConfigModule.forRoot({
    isGlobal: true,
    cache: true,
    // apps/api/.env for overrides, then the monorepo root .env shared with docker compose.
    envFilePath: ['.env', '../../.env'],
    validate: validateEnv,
  });
}

export function loggerModule(service: 'api' | 'worker') {
  return LoggerModule.forRootAsync({
    inject: [ConfigService],
    useFactory: (config: ConfigService<Env, true>) => ({
      pinoHttp: {
        level: config.get('LOG_LEVEL', { infer: true }),
        genReqId: resolveRequestId,
        // Credentials must never reach log storage.
        redact: {
          // Defence in depth behind the serializers below.
          paths: [
            'req.headers.authorization',
            'req.headers.cookie',
            'req.headers.referer',
            'res.headers["set-cookie"]',
            '*.password',
            '*.newPassword',
            '*.currentPassword',
            '*.token',
            '*.resetUrl',
          ],
          censor: '[REDACTED]',
        },
        // Log an allow-list of request fields, never raw headers: Referer can carry a password-
        // reset token (the reset page URL), and headers generally hold personal data.
        serializers: {
          req: (req: {
            id: unknown;
            method: string;
            url: string;
            headers: Record<string, unknown>;
          }) => ({
            id: req.id,
            method: req.method,
            url: req.url,
            userAgent: req.headers['user-agent'],
          }),
          res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
        },
        customProps: () => ({ service }),
        // Health probes run every few seconds; logging them only adds noise.
        autoLogging: { ignore: (req) => req.url?.includes('/health/') ?? false },
        ...(config.get('LOG_PRETTY', { infer: true })
          ? { transport: { target: 'pino-pretty', options: { singleLine: true } } }
          : {}),
      },
    }),
  });
}
