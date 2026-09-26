import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';

import { AccessTokenService } from './access-token.service';
import type { AuthenticatedRequest } from './auth.types';
import { IS_PUBLIC_KEY } from './decorators';
import { SessionRevocationService } from './session-revocation.service';

/**
 * Global guard: every route requires a valid access token unless marked @Public(), so a new
 * endpoint is secure by default and forgetting a decorator fails closed.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: AccessTokenService,
    private readonly revocation: SessionRevocationService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest<Request>();
    const res = context.switchToHttp().getResponse<Response>();
    const header = req.get('authorization') ?? '';
    const [scheme, token] = header.split(' ');

    const reject = (reason: string): never => {
      res.setHeader('WWW-Authenticate', 'Bearer');
      throw new UnauthorizedException(reason);
    };

    if (scheme !== 'Bearer' || !token) return reject('Missing bearer token');

    let verified;
    try {
      verified = await this.tokens.verify(token);
    } catch {
      return reject('Invalid or expired access token');
    }
    if (await this.revocation.isRevoked(verified.id, verified.issuedAt)) {
      return reject('Session revoked');
    }

    (req as AuthenticatedRequest).user = { id: verified.id, isAdmin: verified.isAdmin };
    return true;
  }
}
