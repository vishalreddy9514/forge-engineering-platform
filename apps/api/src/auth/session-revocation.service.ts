import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Redis } from 'ioredis';

import type { Env } from '../config/env';
import { REDIS_CLIENT } from '../infrastructure/redis/redis.module';

/**
 * Makes deactivation and role changes take effect immediately instead of when the user's access
 * token expires. Redis stores "tokens issued at or before this second are void" per user, with a
 * TTL of one access-token lifetime (after that, every such token has expired anyway). Tokens
 * issued later, e.g. after a demoted admin refreshes, carry the new claims and are accepted.
 */
@Injectable()
export class SessionRevocationService {
  private readonly logger = new Logger(SessionRevocationService.name);

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly config: ConfigService<Env, true>,
  ) {}

  /**
   * Voids the user's access tokens issued before the current second. `iat` has one-second
   * resolution, so the cutoff sits one second back: a token issued in the same moment as the
   * revocation (e.g. the new session after a password change) must stay valid.
   */
  async revokeExistingAccessTokens(userId: string): Promise<void> {
    const ttl = this.config.get('ACCESS_TOKEN_TTL_SECONDS', { infer: true });
    const cutoff = Math.floor(Date.now() / 1000) - 1;
    await this.redis.set(this.key(userId), String(cutoff), 'EX', ttl);
  }

  /** `issuedAt` is the token's `iat` (seconds). */
  async isRevoked(userId: string, issuedAt: number): Promise<boolean> {
    try {
      const cutoff = await this.redis.get(this.key(userId));
      return cutoff !== null && issuedAt <= Number(cutoff);
    } catch (error) {
      // Fail open: tokens are short-lived and refresh re-checks the database.
      this.logger.warn({ err: error }, 'Revocation check unavailable');
      return false;
    }
  }

  private key(userId: string): string {
    return `auth:revoked-user:${userId}`;
  }
}
