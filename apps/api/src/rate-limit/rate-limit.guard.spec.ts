import type { ExecutionContext } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';

import type { Env } from '../config/env';
import { RateLimitGuard } from './rate-limit.guard';
import type { RateLimiterService } from './rate-limiter.service';

function handler() {
  return undefined;
}

describe('RateLimitGuard', () => {
  const context = {
    getHandler: () => handler,
    getClass: () => RateLimitGuard,
    switchToHttp: () => ({
      getRequest: () => ({ ip: '203.0.113.7' }),
      getResponse: () => ({ setHeader: jest.fn() }),
    }),
  } as unknown as ExecutionContext;

  const guard = (enabled: boolean, allowed: boolean) => {
    const consume = jest.fn().mockResolvedValue({ allowed, remaining: 0, resetMs: 1000 });
    const config = { get: () => enabled } as unknown as ConfigService<Env, true>;
    const limiter = { consume } as unknown as RateLimiterService;
    return { guard: new RateLimitGuard(new Reflector(), limiter, config), consume };
  };

  it('counts requests and refuses them over the limit', async () => {
    const { guard: g, consume } = guard(true, false);
    await expect(g.canActivate(context)).rejects.toThrow();
    expect(consume).toHaveBeenCalledWith('api:ip:203.0.113.7', 300, 60_000);
  });

  it('lets everything through without counting when limits are turned off', async () => {
    const { guard: g, consume } = guard(false, false);
    await expect(g.canActivate(context)).resolves.toBe(true);
    expect(consume).not.toHaveBeenCalled();
  });
});
