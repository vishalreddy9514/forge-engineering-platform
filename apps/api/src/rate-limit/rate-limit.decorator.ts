import { SetMetadata } from '@nestjs/common';

export interface RateLimitOptions {
  /** Bucket name, so different routes do not share a counter. */
  name: string;
  limit: number;
  windowSeconds: number;
  /** Count per client IP (unauthenticated routes) or per user, falling back to IP. */
  by: 'ip' | 'user';
}

export const RATE_LIMIT_KEY = 'rateLimit';
export const SKIP_RATE_LIMIT_KEY = 'skipRateLimit';

/** Default for authenticated API traffic (architecture §6.5). */
export const DEFAULT_RATE_LIMIT: RateLimitOptions = {
  name: 'api',
  limit: 300,
  windowSeconds: 60,
  by: 'user',
};

export const RateLimit = (options: RateLimitOptions) => SetMetadata(RATE_LIMIT_KEY, options);
export const SkipRateLimit = () => SetMetadata(SKIP_RATE_LIMIT_KEY, true);
