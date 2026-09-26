import type { Redis } from 'ioredis';

import { RateLimiterService } from './rate-limiter.service';

describe('RateLimiterService', () => {
  it('allows until the limit and reports what remains', async () => {
    const redis = { eval: jest.fn() };
    const limiter = new RateLimiterService(redis as unknown as Redis);

    redis.eval.mockResolvedValueOnce([3, 45_000]);
    await expect(limiter.consume('k', 3, 60_000)).resolves.toEqual({
      allowed: true,
      count: 3,
      remaining: 0,
      resetMs: 45_000,
    });

    redis.eval.mockResolvedValueOnce([4, 44_000]);
    await expect(limiter.consume('k', 3, 60_000)).resolves.toMatchObject({ allowed: false });
  });

  it('fails open (allows) when Redis is unavailable', async () => {
    const limiter = new RateLimiterService({
      eval: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')),
    } as unknown as Redis);
    await expect(limiter.consume('k', 1, 1000)).resolves.toMatchObject({ allowed: true });
  });
});
