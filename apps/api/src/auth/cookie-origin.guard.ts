import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';

import type { Env } from '../config/env';

/**
 * CSRF defence for the endpoints authenticated by the refresh cookie (refresh, logout), on top
 * of SameSite=Strict: browsers always send Origin on POST, so a request from any other site is
 * rejected. Requests without Origin come from non-browser clients, which cannot be tricked into
 * sending someone else's cookie.
 */
@Injectable()
export class CookieOriginGuard implements CanActivate {
  private readonly trusted: Set<string>;

  constructor(config: ConfigService<Env, true>) {
    this.trusted = new Set(
      [
        config.get('WEB_ORIGIN', { infer: true }),
        ...config.get('CORS_ORIGINS', { infer: true }),
      ].map((origin) => new URL(origin).origin),
    );
  }

  canActivate(context: ExecutionContext): boolean {
    const origin = context.switchToHttp().getRequest<Request>().get('origin');
    if (origin !== undefined && !this.trusted.has(origin)) {
      throw new ForbiddenException('Cross-site request rejected');
    }
    return true;
  }
}
