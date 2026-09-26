import { Injectable } from '@nestjs/common';

import { TooManyRequestsException } from '../common/errors/too-many-requests.exception';
import { RateLimiterService } from '../rate-limit/rate-limiter.service';
import { hashToken } from './token-hash';

const WINDOW_MS = 15 * 60 * 1000;
/** Failed attempts per account before it is temporarily locked (FR-1.7). */
export const MAX_FAILURES_PER_ACCOUNT = 5;
/** Failed attempts per IP across all accounts (credential stuffing from one source). */
export const MAX_FAILURES_PER_IP = 20;

/**
 * Brute-force protection for login. Counters apply to any submitted email, whether or not an
 * account exists, so lockout behaviour cannot be used to discover registered emails.
 */
@Injectable()
export class LoginThrottleService {
  constructor(private readonly limiter: RateLimiterService) {}

  async assertNotLocked(email: string, ip: string | null): Promise<void> {
    const [account, source] = await Promise.all([
      this.limiter.peek(this.accountKey(email)),
      this.limiter.peek(this.ipKey(ip)),
    ]);
    const blocked = [
      account.count >= MAX_FAILURES_PER_ACCOUNT ? account.resetMs : 0,
      source.count >= MAX_FAILURES_PER_IP ? source.resetMs : 0,
    ];
    const waitMs = Math.max(...blocked);
    if (waitMs > 0) {
      throw new TooManyRequestsException(
        Math.ceil(waitMs / 1000),
        'Too many failed sign-in attempts. Try again later.',
      );
    }
  }

  async recordFailure(email: string, ip: string | null): Promise<void> {
    await Promise.all([
      this.limiter.consume(this.accountKey(email), MAX_FAILURES_PER_ACCOUNT, WINDOW_MS),
      this.limiter.consume(this.ipKey(ip), MAX_FAILURES_PER_IP, WINDOW_MS),
    ]);
  }

  async recordSuccess(email: string): Promise<void> {
    await this.limiter.reset(this.accountKey(email));
  }

  // Hash the email so Redis keys do not hold personal data.
  private accountKey(email: string): string {
    return `login-fail:account:${hashToken(email)}`;
  }

  private ipKey(ip: string | null): string {
    return `login-fail:ip:${ip ?? 'unknown'}`;
  }
}
