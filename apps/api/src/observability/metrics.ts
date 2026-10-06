import type { Queue } from 'bullmq';
import type { Pool } from 'pg';
import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from 'prom-client';

/**
 * Prometheus metrics for the API and the worker (architecture §11). One registry per process,
 * served on its own port (metrics.server.ts), never through the proxy or the load balancer.
 *
 * Labels are bounded on purpose: routes are templates (`/api/v1/projects/:projectId`), never raw
 * paths, and nothing is labelled by user, project or issue.
 */
export const registry = new Registry();
collectDefaultMetrics({ register: registry });

const LATENCY_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

export const httpRequestDuration = new Histogram({
  name: 'forge_http_request_duration_seconds',
  help: 'HTTP requests by route template, method and status code',
  labelNames: ['method', 'route', 'status'] as const,
  buckets: LATENCY_BUCKETS,
  registers: [registry],
});

export const jobDuration = new Histogram({
  name: 'forge_job_duration_seconds',
  help: 'Background job attempts by queue, job name and outcome (completed, failed, delayed)',
  labelNames: ['queue', 'job', 'outcome'] as const,
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 2.5, 5, 10, 30, 60, 120],
  registers: [registry],
});

export const jobsDeadLettered = new Counter({
  name: 'forge_jobs_dead_lettered_total',
  help: 'Jobs that failed their last attempt and stay in the failed set for inspection',
  labelNames: ['queue', 'job'] as const,
  registers: [registry],
});

export const githubRateLimitRemaining = new Gauge({
  name: 'forge_github_rate_limit_remaining',
  help: 'Requests left in the current GitHub rate-limit window, per App installation',
  labelNames: ['installation'] as const,
  registers: [registry],
});

export const aiUnavailable = new Counter({
  name: 'forge_ai_unavailable_total',
  help: 'Calls to the AI service that found it unreachable or unconfigured (degraded mode)',
  registers: [registry],
});

// Gauges read at scrape time from the live objects that register here. Sets, not single
// references, because tests start several applications in one process.
export const observedPools = new Set<Pool>();
export const observedQueues = new Set<Queue>();

new Gauge({
  name: 'forge_db_pool_connections',
  help: 'PostgreSQL pool connections: total open, idle, and requests waiting for one',
  labelNames: ['state'] as const,
  registers: [registry],
  collect() {
    let total = 0;
    let idle = 0;
    let waiting = 0;
    for (const pool of observedPools) {
      total += pool.totalCount;
      idle += pool.idleCount;
      waiting += pool.waitingCount;
    }
    this.set({ state: 'total' }, total);
    this.set({ state: 'idle' }, idle);
    this.set({ state: 'waiting' }, waiting);
  },
});

export const QUEUE_STATES = ['waiting', 'active', 'delayed', 'failed'] as const;

new Gauge({
  name: 'forge_queue_jobs',
  help: 'Jobs per queue and state (failed = dead-lettered, kept for inspection)',
  labelNames: ['queue', 'state'] as const,
  registers: [registry],
  async collect() {
    await Promise.all(
      [...observedQueues].map(async (queue) => {
        try {
          const counts = await queue.getJobCounts(...QUEUE_STATES);
          for (const state of QUEUE_STATES)
            this.set({ queue: queue.name, state }, counts[state] ?? 0);
        } catch {
          // Redis unreachable: report nothing for this queue rather than failing the scrape.
        }
      }),
    );
  },
});

/**
 * Route label for a finished Express request: its template, or "unmatched" for paths no
 * controller handles (Nest answers those through a wildcard route, `/api/v1{/*splat}`; Forge
 * declares no wildcard routes of its own).
 */
export function routeLabel(req: { baseUrl?: string; route?: { path?: unknown } }): string {
  const path = req.route?.path;
  if (typeof path !== 'string' || path.includes('*')) return 'unmatched';
  return `${req.baseUrl ?? ''}${path}`;
}
