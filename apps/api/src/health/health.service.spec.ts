import { Logger } from '@nestjs/common';

import { HEALTH_CHECK_TIMEOUT_MS, HealthService } from './health.service';
import type { HealthIndicator } from './health-indicator';

const indicator = (name: string, check: () => Promise<void>): HealthIndicator => ({ name, check });

describe('HealthService.readiness', () => {
  beforeAll(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
  });

  afterAll(() => {
    jest.restoreAllMocks();
  });

  it('is ok when every check passes', async () => {
    const service = new HealthService([
      indicator('redis', () => Promise.resolve()),
      indicator('database', () => Promise.resolve()),
    ]);

    await expect(service.readiness()).resolves.toEqual({
      status: 'ok',
      checks: { redis: { status: 'ok' }, database: { status: 'ok' } },
    });
  });

  it('reports the failing dependency without leaking the driver error', async () => {
    const service = new HealthService([
      indicator('redis', () => Promise.reject(new Error('connect ECONNREFUSED 10.0.3.17:6379'))),
      indicator('database', () => Promise.resolve()),
    ]);

    await expect(service.readiness()).resolves.toEqual({
      status: 'error',
      checks: {
        redis: { status: 'error', message: 'Unavailable' },
        database: { status: 'ok' },
      },
    });
  });

  it('logs the full error for operators', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn');
    const error = new Error('connect ECONNREFUSED 10.0.3.17:6379');
    await new HealthService([indicator('redis', () => Promise.reject(error))]).readiness();

    expect(warn).toHaveBeenCalledWith({ check: 'redis', err: error }, 'Readiness check failed');
  });

  it('fails a check that hangs instead of hanging itself', async () => {
    jest.useFakeTimers();
    try {
      const service = new HealthService([indicator('slow', () => new Promise(() => undefined))]);
      const pending = service.readiness();
      await jest.advanceTimersByTimeAsync(HEALTH_CHECK_TIMEOUT_MS);

      await expect(pending).resolves.toEqual({
        status: 'error',
        checks: {
          slow: { status: 'error', message: `Timed out after ${HEALTH_CHECK_TIMEOUT_MS} ms` },
        },
      });
    } finally {
      jest.useRealTimers();
    }
  });
});
