import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';

import { REDIS_CLIENT } from '../infrastructure/redis/redis.module';

export interface RateLimitResult {
  allowed: boolean;
  /** Requests counted in the current window, including this one. */
  count: number;
  remaining: number;
  /** Milliseconds until the window resets. */
  resetMs: number;
}

// INCR and set the expiry in one atomic step, so a crash between the two can never leave a
// counter without a TTL (which would block that key forever).
const INCREMENT_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
local ttl = redis.call('PTTL', KEYS[1])
return { count, ttl }
`;

/**
 * Fixed-window counters in Redis, shared by every API instance. If Redis is unavailable the
 * limiter fails open (allows the request and logs a warning): a Redis outage should degrade
 * abuse protection, not take the whole API down.
 */
@Injectable()
export class RateLimiterService {
  private readonly logger = new Logger(RateLimiterService.name);

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async consume(key: string, limit: number, windowMs: number): Promise<RateLimitResult> {
    try {
      const [count, ttl] = (await this.redis.eval(INCREMENT_SCRIPT, 1, `rl:${key}`, windowMs)) as [
        number,
        number,
      ];
      return {
        allowed: count <= limit,
        count,
        remaining: Math.max(0, limit - count),
        resetMs: ttl > 0 ? ttl : windowMs,
      };
    } catch (error) {
      this.logger.warn({ err: error, key }, 'Rate limiter unavailable; allowing request');
      return { allowed: true, count: 0, remaining: limit, resetMs: windowMs };
    }
  }

  /** Current count without incrementing (0 if unknown or Redis is down). */
  async peek(key: string): Promise<{ count: number; resetMs: number }> {
    try {
      const [count, ttl] = await Promise.all([
        this.redis.get(`rl:${key}`),
        this.redis.pttl(`rl:${key}`),
      ]);
      return { count: Number(count ?? 0), resetMs: Math.max(ttl, 0) };
    } catch {
      return { count: 0, resetMs: 0 };
    }
  }

  async reset(key: string): Promise<void> {
    try {
      await this.redis.del(`rl:${key}`);
    } catch (error) {
      this.logger.warn({ err: error, key }, 'Could not reset rate-limit counter');
    }
  }
}
