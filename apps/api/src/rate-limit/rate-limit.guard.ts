import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';

import type { AuthenticatedRequest } from '../auth/auth.types';
import { TooManyRequestsException } from '../common/errors/too-many-requests.exception';
import {
  DEFAULT_RATE_LIMIT,
  RATE_LIMIT_KEY,
  type RateLimitOptions,
  SKIP_RATE_LIMIT_KEY,
} from './rate-limit.decorator';
import { RateLimiterService } from './rate-limiter.service';

/**
 * Global guard, registered after authentication so authenticated traffic is counted per user
 * (many users can share one office NAT IP) and anonymous traffic per IP.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly limiter: RateLimiterService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(SKIP_RATE_LIMIT_KEY, targets)) return true;

    const options =
      this.reflector.getAllAndOverride<RateLimitOptions | undefined>(RATE_LIMIT_KEY, targets) ??
      DEFAULT_RATE_LIMIT;
    const req = context.switchToHttp().getRequest<Request & Partial<AuthenticatedRequest>>();
    const res = context.switchToHttp().getResponse<Response>();

    const identity =
      options.by === 'user' && req.user ? `user:${req.user.id}` : `ip:${req.ip ?? 'unknown'}`;
    const result = await this.limiter.consume(
      `${options.name}:${identity}`,
      options.limit,
      options.windowSeconds * 1000,
    );

    // IETF RateLimit header fields (draft-ietf-httpapi-ratelimit-headers).
    const resetSeconds = Math.ceil(result.resetMs / 1000);
    res.setHeader('RateLimit-Limit', options.limit);
    res.setHeader('RateLimit-Remaining', result.remaining);
    res.setHeader('RateLimit-Reset', resetSeconds);

    if (!result.allowed) throw new TooManyRequestsException(resetSeconds);
    return true;
  }
}
