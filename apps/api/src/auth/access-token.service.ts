import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'node:crypto';

import type { Env } from '../config/env';
import { type AccessTokenClaims, type AuthUser, JWT_AUDIENCE, JWT_ISSUER } from './auth.types';

@Injectable()
export class AccessTokenService {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  get ttlSeconds(): number {
    return this.config.get('ACCESS_TOKEN_TTL_SECONDS', { infer: true });
  }

  sign(user: AuthUser): Promise<string> {
    return this.jwt.signAsync(
      { adm: user.isAdmin },
      { subject: user.id, jwtid: randomUUID(), expiresIn: this.ttlSeconds },
    );
  }

  /** Rejects anything that is not a valid, unexpired ES256 token issued by and for Forge. */
  async verify(token: string): Promise<AuthUser & { issuedAt: number }> {
    const claims = await this.jwt.verifyAsync<AccessTokenClaims>(token, {
      algorithms: ['ES256'],
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
    });
    return { id: claims.sub, isAdmin: claims.adm, issuedAt: claims.iat };
  }
}
