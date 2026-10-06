import { DelayedError, type Job, UnrecoverableError } from 'bullmq';
import type { ConfigService } from '@nestjs/config';
import { createServer } from 'node:net';
import type { Pool } from 'pg';

import type { Env } from '../config/env';
import { Instrumented, runJob } from './instrumented';
import { MetricsServer } from './metrics.server';
import { observedPools, observedQueues, registry, routeLabel } from './metrics';
import { currentRequestId, runWithRequestId, traced } from './request-context';

const job = (overrides: Partial<Job> = {}) =>
  ({
    id: '7',
    name: 'issue-summary',
    data: {},
    attemptsMade: 0,
    opts: { attempts: 3 },
    ...overrides,
  }) as Job;

/** The value of one sample, e.g. value('forge_job_duration_seconds_count', { outcome: 'failed' }). */
async function value(metric: string, labels: Record<string, string>): Promise<number> {
  const name = metric.replace(/_(count|sum|bucket)$/, '');
  const found = (await registry.getMetricsAsJSON()).find((m) => m.name === name);
  const sample = (found?.values ?? []).find((v) => {
    const sampleName = (v as { metricName?: string }).metricName ?? name;
    return (
      sampleName === metric &&
      Object.entries(labels).every(([k, want]) => String(v.labels[k]) === want)
    );
  });
  return sample?.value ?? 0;
}

beforeEach(() => {
  registry.resetMetrics();
});

describe('request context', () => {
  it('attaches the current request ID to job data, and nothing outside a request', () => {
    expect(traced({ issueId: 'i1' })).toEqual({ issueId: 'i1' });
    runWithRequestId('req-1', () => {
      expect(currentRequestId()).toBe('req-1');
      expect(traced({ issueId: 'i1' })).toEqual({ issueId: 'i1', requestId: 'req-1' });
    });
  });
});

describe('routeLabel', () => {
  it('labels by route template, never by raw path, and groups unmatched requests', () => {
    expect(routeLabel({ baseUrl: '', route: { path: '/api/v1/issues/:issueId' } })).toBe(
      '/api/v1/issues/:issueId',
    );
    expect(routeLabel({ baseUrl: '/api/v1', route: { path: '/projects/:projectId' } })).toBe(
      '/api/v1/projects/:projectId',
    );
    expect(routeLabel({})).toBe('unmatched');
    expect(routeLabel({ route: { path: '/api/v1{/*splat}' } })).toBe('unmatched');
  });
});

describe('runJob', () => {
  const COUNT = 'forge_job_duration_seconds_count';

  it('runs under the request ID that enqueued the job and counts a completed attempt', async () => {
    const seen = await runJob('ai', job({ data: { requestId: 'req-42' } }), () =>
      Promise.resolve(currentRequestId()),
    );
    expect(seen).toBe('req-42');
    expect(await value(COUNT, { queue: 'ai', job: 'issue-summary', outcome: 'completed' })).toBe(1);
  });

  it('gives scheduled jobs an ID of their own and replaces unsafe ones', async () => {
    expect(await runJob('maintenance', job(), () => Promise.resolve(currentRequestId()))).toBe(
      'maintenance-7',
    );
    const unsafe = job({ data: { requestId: 'bad id\nwith newline' } });
    expect(await runJob('ai', unsafe, () => Promise.resolve(currentRequestId()))).toBe('ai-7');
  });

  it('counts a failed attempt, and a dead letter only on the last attempt', async () => {
    const boom = () => Promise.reject(new Error('boom'));
    await expect(runJob('ai', job({ attemptsMade: 0 }), boom)).rejects.toThrow('boom');
    expect(await value(COUNT, { queue: 'ai', outcome: 'failed' })).toBe(1);
    expect(await value('forge_jobs_dead_lettered_total', { queue: 'ai' })).toBe(0);

    await expect(runJob('ai', job({ attemptsMade: 2 }), boom)).rejects.toThrow('boom');
    expect(await value('forge_jobs_dead_lettered_total', { queue: 'ai' })).toBe(1);
  });

  it('dead-letters an unrecoverable error at once, and does not count a postponement as failed', async () => {
    await expect(
      runJob('github', job(), () => Promise.reject(new UnrecoverableError('malformed'))),
    ).rejects.toThrow('malformed');
    expect(await value('forge_jobs_dead_lettered_total', { queue: 'github' })).toBe(1);

    await expect(
      runJob('github', job(), () => Promise.reject(new DelayedError())),
    ).rejects.toThrow();
    expect(await value(COUNT, { queue: 'github', outcome: 'delayed' })).toBe(1);
    expect(await value(COUNT, { queue: 'github', outcome: 'failed' })).toBe(1);
  });

  it('instruments a processor class through the decorator', async () => {
    @Instrumented('email')
    class Processor {
      process(j: Job): Promise<string | undefined> {
        return Promise.resolve(`${j.name}:${currentRequestId() ?? ''}`);
      }
    }
    const result = await new Processor().process(
      job({ name: 'password-reset', data: { requestId: 'r9' } }),
    );
    expect(result).toBe('password-reset:r9');
    expect(await value(COUNT, { queue: 'email', job: 'password-reset' })).toBe(1);
  });
});

describe('scrape-time gauges', () => {
  afterEach(() => {
    observedPools.clear();
    observedQueues.clear();
  });

  it('reports database pool saturation', async () => {
    observedPools.add({ totalCount: 10, idleCount: 2, waitingCount: 3 } as Pool);
    expect(await value('forge_db_pool_connections', { state: 'total' })).toBe(10);
    expect(await value('forge_db_pool_connections', { state: 'waiting' })).toBe(3);
  });

  it('reports queue depth per state, skipping a queue it cannot read', async () => {
    observedQueues.add({
      name: 'ai',
      getJobCounts: () => Promise.resolve({ waiting: 4, active: 1, delayed: 0, failed: 2 }),
    } as never);
    observedQueues.add({
      name: 'email',
      getJobCounts: () => Promise.reject(new Error('down')),
    } as never);
    expect(await value('forge_queue_jobs', { queue: 'ai', state: 'waiting' })).toBe(4);
    expect(await value('forge_queue_jobs', { queue: 'ai', state: 'failed' })).toBe(2);
    const text = await registry.metrics();
    expect(text).not.toContain('queue="email"');
  });
});

describe('MetricsServer', () => {
  const freePort = () =>
    new Promise<number>((resolve) => {
      const probe = createServer().listen(0, () => {
        const address = probe.address() as { port: number };
        probe.close(() => {
          resolve(address.port);
        });
      });
    });
  const server = (port: number) =>
    new MetricsServer({ get: () => port } as unknown as ConfigService<Env, true>);

  it('serves Prometheus text on /metrics and nothing else', async () => {
    const port = await freePort();
    const metrics = server(port);
    await metrics.onApplicationBootstrap();
    try {
      const res = await fetch(`http://127.0.0.1:${String(port)}/metrics`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/plain');
      expect(await res.text()).toContain('forge_http_request_duration_seconds');
      expect((await fetch(`http://127.0.0.1:${String(port)}/`)).status).toBe(404);
      expect(
        (await fetch(`http://127.0.0.1:${String(port)}/metrics`, { method: 'POST' })).status,
      ).toBe(404);
    } finally {
      await metrics.onApplicationShutdown();
    }
  });

  it('runs without metrics, rather than crashing, when the port is taken', async () => {
    const port = await freePort();
    const first = server(port);
    const second = server(port);
    await first.onApplicationBootstrap();
    try {
      await expect(second.onApplicationBootstrap()).resolves.toBeUndefined();
      await second.onApplicationShutdown();
      expect((await fetch(`http://127.0.0.1:${String(port)}/metrics`)).status).toBe(200);
    } finally {
      await first.onApplicationShutdown();
    }
  });

  it('stays off with METRICS_PORT=0', async () => {
    const metrics = server(0);
    await metrics.onApplicationBootstrap();
    await metrics.onApplicationShutdown();
  });
});
